/**
 * SyncEngine — Central Orchestrator (Singleton)
 *
 * The core brain of the extension. Coordinates between:
 *   - ConnectionManager (transport layer)
 *   - SyncStateMachine (session lifecycle)
 *   - CommandFactory (deserializing incoming sync commands)
 *   - ClockSync (latency compensation)
 *   - EventBus (observer notifications)
 *
 * OOP Pillar: Singleton — one SyncEngine per service worker, acting as the
 * Mediator between all subsystems.
 *
 * OS Pillar: The service worker is an event-driven daemon; SyncEngine persists
 * its state in chrome.storage so it survives worker restarts.
 */

import { EventBus } from './EventBus.js';
import { ConnectionManager } from './ConnectionManager.js';
import { SyncStateMachine, SyncState } from './state/SyncStateMachine.js';
import { ClockSync } from './ClockSync.js';
import { CommandFactory } from './commands/SyncCommand.js';
import { InterruptionModule } from './InterruptionModule.js';

// Import concrete commands so they self-register with CommandFactory
import './commands/PlayCommand.js';
import './commands/PauseCommand.js';
import './commands/SeekCommand.js';
import './commands/ForceSyncCommand.js';
import './commands/RoomStateCommand.js';
import './commands/RequestStateCommand.js';
import './commands/DriftCommand.js';

/**
 * How often the host publishes its position.
 *
 * This doubles as the upper bound on how long a peer can be out of sync before
 * anyone notices, so it is the single biggest lever on perceived sync quality.
 * 2s keeps worst-case detection latency low while staying light on the relay,
 * and the resulting WebSocket traffic keeps both the MV3 service worker and a
 * free-tier server from idling out.
 */
const HEARTBEAT_INTERVAL_MS = 2000;

/** How often a non-host measures RTT. Path delay changes far slower than position. */
const PING_INTERVAL_MS = 6000;

/**
 * How often to prove this peer is still connected, over the WebSocket.
 *
 * Once the mesh carries playback the WebSocket falls completely silent, which
 * the server cannot tell apart from a dead connection: its stale-peer reaper
 * would close the socket of a peer that is working perfectly, and reaping the
 * last one deletes the room along with the playback position everyone resyncs
 * to. Comfortably under the server's 45s timeout, so two can be lost.
 */
const KEEPALIVE_INTERVAL_MS = 15000;

/**
 * Drift above which a correction is issued.
 *
 * Below this the correction itself would be more disruptive than the error.
 * Playback-rate nudging (see YouTubeAdapter.syncTo) absorbs corrections in this
 * range invisibly, which is what makes such a tight threshold usable at all —
 * a hard seek every 2s would be unwatchable.
 */
const DRIFT_TOLERANCE_S = 0.35;

/** chrome.storage writes are throttled to this interval. */
const PERSIST_INTERVAL_MS = 10000;

/**
 * Generate a random 6-character alphanumeric room code.
 * @returns {string}
 */
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No ambiguous chars (0/O, 1/I/L)
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

/**
 * Generate a unique peer ID.
 * @returns {string}
 */
function generatePeerId() {
  return 'peer_' + crypto.randomUUID().slice(0, 8);
}

export class SyncEngine {
  constructor() {
    /** @type {EventBus} */
    this.eventBus = new EventBus();

    /** @type {ConnectionManager} */
    this.connectionManager = new ConnectionManager(this.eventBus);

    /** @type {SyncStateMachine} */
    this.stateMachine = new SyncStateMachine(this.eventBus);

    /** @type {ClockSync} */
    this.clockSync = new ClockSync();

    /** @type {InterruptionModule} */
    this.interruptionModule = new InterruptionModule(this, this.connectionManager);

    this.connectionManager.onMessage(this.handleSyncMessage.bind(this));

    /** @type {string|null} This peer's ID (persisted in chrome.storage.session) */
    this._peerId = null;

    /** @type {string|null} */
    this._roomId = null;

    /** @type {boolean} */
    this._isHost = false;

    /** @type {string|null} The room's current host, as reported by the server */
    this._hostId = null;

    /** @type {number} Lamport logical clock */
    this._lamportClock = 0;

    /** @type {number|null} Interval ID for the heartbeat/ping cycle */
    this._heartbeatIntervalId = null;

    /** @type {number} Ticks elapsed, used to run PING on a slower cadence */
    this._heartbeatTick = 0;

    /**
     * Cached YouTube tab, so the command hot path does not pay for a
     * chrome.tabs.query on every inbound message.
     * @type {number|null}
     */
    this._activeTabId = null;

    /** @type {number} Timestamp of the last chrome.storage write */
    this._lastPersistAt = 0;

    /** @type {number|null} Timer that settles DRIFTING back to SYNCED */
    this._driftSettleTimerId = null;

    this._setupEventHandlers();
  }

  /**
   * Initialize the engine, restoring state from storage if available.
   * @returns {Promise<void>}
   */
  async init() {
    const stored = await chrome.storage.session.get([
      'peerId', 'roomId', 'isHost', 'lamportClock'
    ]);

    this._peerId = stored.peerId || generatePeerId();
    this._roomId = stored.roomId || null;
    this._isHost = stored.isHost || false;
    this._lamportClock = stored.lamportClock || 0;

    if (!stored.peerId) {
      await chrome.storage.session.set({ peerId: this._peerId });
    }

    console.log(`[SyncEngine] Initialized — peerId=${this._peerId}`);
  }

  /**
   * Create a new room and become the host.
   * @returns {Promise<{roomId: string, peerId: string}>}
   */
  async createRoom() {
    // Leaving first keeps a second Create click from stacking a new connection
    // on top of a live one, and puts the state machine in a known state.
    if (this._roomId) await this.leaveRoom();

    const roomId = generateRoomCode();
    this._roomId = roomId;
    this._isHost = true;
    this._hostId = this._peerId;

    this._enterState(SyncState.JOINING);

    await this.connectionManager.connect(roomId, this._peerId);
    await this._persistState(true);

    console.log(`[SyncEngine] Created room ${roomId} as host`);
    return { roomId, peerId: this._peerId };
  }

  /**
   * Join an existing room by code.
   * @param {string} roomId - 6-character room code
   * @returns {Promise<{roomId: string, peerId: string}>}
   */
  async joinRoom(roomId) {
    if (this._roomId) await this.leaveRoom();

    this._roomId = roomId.toUpperCase();
    this._isHost = false;
    this._hostId = null;

    this._enterState(SyncState.JOINING);

    await this.connectionManager.connect(this._roomId, this._peerId);
    await this._persistState(true);

    console.log(`[SyncEngine] Joined room ${this._roomId}`);
    return { roomId: this._roomId, peerId: this._peerId };
  }

  /**
   * Re-establish the connection if the service worker woke up to find it gone.
   * @returns {Promise<void>}
   */
  async ensureConnection() {
    if (!this._roomId || this.connectionManager.isConnected()) return;

    console.log(`[SyncEngine] Re-establishing connection for room ${this._roomId}...`);

    // JOINING is the only state connect() can legally proceed from, and a woken
    // worker starts at DISCONNECTED. Without this the subsequent
    // 'connection:established' transition is rejected and the UI stays stuck
    // reading "Not connected" while sync is in fact working.
    this._enterState(SyncState.JOINING);

    await this.connectionManager.connect(this._roomId, this._peerId);
  }

  /**
   * Alias for leaveRoom, utilized by internal modules (e.g., InterruptionModule).
   */
  disconnect() {
    this.leaveRoom();
  }

  /**
   * Leave the current room.
   * @returns {Promise<void>}
   */
  async leaveRoom() {
    this._stopHeartbeat();
    this._clearDriftSettleTimer();
    this.interruptionModule.clearAll();

    if (this._roomId) {
      await this.connectionManager.disconnect();
    }

    this._roomId = null;
    this._isHost = false;
    this._hostId = null;
    this._activeTabId = null;
    this.clockSync.reset();
    this.stateMachine.reset();

    await this._persistState(true);
    console.log('[SyncEngine] Left room');
  }

  // ── Inbound message handling ──────────────────────────────────

  /**
   * Handle an incoming sync message from a peer.
   * @param {object} wireMessage - Full wire protocol message
   */
  handleSyncMessage(wireMessage) {
    // Lamport clock: max(local, received) + 1
    this._lamportClock = Math.max(this._lamportClock, wireMessage.lamportClock || 0) + 1;

    const { type, payload = {} } = wireMessage;

    switch (type) {
      case 'ROOM_STATE':
        // Carries the authoritative host, which decides whether this peer
        // answers PINGs and publishes heartbeats.
        if (payload.hostId) this._adoptHost(payload.hostId);
        break;

      case 'HOST_CHANGE':
        if (payload.newHostId) this._adoptHost(payload.newHostId);
        return;

      case 'PING':
        this._handlePing(wireMessage);
        return;

      case 'PONG':
        this._handlePong(wireMessage);
        return;

      case 'HEARTBEAT':
        // Fire and forget, but never unhandled: an async handler invoked
        // without a catch surfaces as an "Uncaught (in promise)" error on the
        // extension's card in chrome://extensions.
        this._handleHeartbeat(wireMessage).catch((err) => {
          console.error('[SyncEngine] Heartbeat handling failed:', err);
        });
        return;

      case 'JOIN':
      case 'LEAVE':
      case 'KEEPALIVE':
        // Membership is ConnectionManager's business and was already applied
        // before this point. They reach here only because every inbound message
        // does; passing them to CommandFactory just logs "Unknown command type"
        // on each one and buries the real errors.
        return;

      default:
        break;
    }

    const command = CommandFactory.fromWireMessage(wireMessage);
    if (command) {
      this.eventBus.emit('command:received', {
        command,
        senderId: wireMessage.senderId,
        type,
      });
    }
  }

  /**
   * Only the host answers a PING, and the reply is addressed back to the asker.
   *
   * A broadcast PONG would have every other peer compute
   * `now - someone_else's_clock` and feed that into its RTT average, so the
   * reply must name its recipient.
   *
   * @private
   */
  _handlePing(wireMessage) {
    if (!this._isHost) return;

    this.sendAction('PONG', {
      targetPeerId: wireMessage.senderId,
      pingOriginTimestamp: wireMessage.payload?.originTimestamp,
    });
  }

  /** @private */
  _handlePong(wireMessage) {
    const payload = wireMessage.payload || {};

    // The server routes PONGs, but verify anyway: a sample derived from another
    // peer's ping is pure clock offset, and one bad sample skews compensation.
    if (payload.targetPeerId && payload.targetPeerId !== this._peerId) return;
    if (typeof payload.pingOriginTimestamp !== 'number') return;

    this.clockSync.recordRTT(Date.now() - payload.pingOriginTimestamp);
  }

  /**
   * Compare local playback against the host's and correct if it has drifted.
   * @private
   */
  async _handleHeartbeat(wireMessage) {
    if (this._isHost) return;

    const payload = wireMessage.payload || {};
    const { state: videoState } = await this._getTabVideoState();

    if (!videoState || videoState.videoId !== payload.videoId) return;

    const hostIsPlaying = payload.isPaused === false;
    const targetTime = this.clockSync.compensateTime(
      payload.videoTime,
      payload.originTimestamp,
      hostIsPlaying
    );

    const drift = Math.abs(videoState.videoTime - targetTime);
    const stateMismatch = videoState.isPaused !== payload.isPaused;

    if (drift <= DRIFT_TOLERANCE_S && !stateMismatch) {
      // Within tolerance — promote out of SYNCING once settled.
      if (this.stateMachine.state === SyncState.SYNCING) {
        this._enterState(SyncState.SYNCED);
      }
      return;
    }

    console.log(
      `[SyncEngine] Correcting drift: local=${videoState.videoTime.toFixed(2)}s ` +
      `(${videoState.isPaused ? 'paused' : 'playing'}), ` +
      `host=${targetTime.toFixed(2)}s (${payload.isPaused ? 'paused' : 'playing'}), ` +
      `Δ${drift.toFixed(2)}s`
    );

    this._enterState(SyncState.DRIFTING);

    // DRIFT rather than ROOM_STATE: the adapter absorbs a small correction by
    // briefly altering playback rate instead of seeking, so routine corrections
    // are inaudible. ROOM_STATE always hard-seeks, which is right for a late
    // joiner but jarring every couple of seconds.
    const correction = this.buildMessage('DRIFT', {
      videoId: payload.videoId,
      videoTime: targetTime,
      isPaused: payload.isPaused,
    });

    this.eventBus.emit('command:received', {
      command: CommandFactory.fromWireMessage(correction),
      senderId: 'host-correction',
      type: 'DRIFT',
    });

    this._scheduleDriftSettle();
  }

  /**
   * Record who the host is and react if it is now this peer.
   * @private
   */
  _adoptHost(newHostId) {
    this._hostId = newHostId;
    const shouldBeHost = newHostId === this._peerId;

    if (shouldBeHost === this._isHost) return;

    this._isHost = shouldBeHost;
    console.log(`[SyncEngine] ${this._isHost ? 'Promoted to host' : 'No longer host'}`);

    this._fireAndForget(this._persistState(), 'state persist');
    this._broadcastStatusUpdate();

    if (this._isHost) {
      // The old host is gone; publish current state so nobody is left guessing.
      this._fireAndForget(this._broadcastRoomState(), 'room state broadcast');
    }
  }

  // ── Outbound messages ─────────────────────────────────────────

  /**
   * Build a wire protocol message envelope.
   * @param {string} type - Message type (PLAY, PAUSE, SEEK, etc.)
   * @param {object} payload - Message payload
   * @returns {object} Complete wire protocol message
   */
  buildMessage(type, payload = {}) {
    this._lamportClock++;
    return {
      type,
      roomId: this._roomId,
      senderId: this._peerId,
      lamportClock: this._lamportClock,
      payload: {
        ...payload,
        originTimestamp: Date.now(),
      },
    };
  }

  /**
   * Send a sync action to the room.
   * @param {string} type - Message type
   * @param {object} payload - Message payload
   */
  sendAction(type, payload = {}) {
    this.connectionManager.send(this.buildMessage(type, payload));
  }

  handlePause(userId, videoTime) {
    this.sendAction('PAUSE', { videoTime, isPaused: true });
  }

  handlePlay(userId, videoTime) {
    this.sendAction('PLAY', { videoTime, isPaused: false });
  }

  /**
   * User-initiated full reconciliation, from the popup's Force Sync button.
   *
   * The host is the source of truth, so it publishes; everyone else asks.
   * @returns {Promise<void>}
   */
  async forceSync() {
    if (this._isHost) {
      await this._broadcastRoomState();
    } else {
      this.sendAction('REQUEST_STATE', {});
    }
  }

  /**
   * Get the current engine state for the popup/content script.
   * @returns {object}
   */
  getStatus() {
    return {
      peerId: this._peerId,
      roomId: this._roomId,
      isHost: this._isHost,
      state: this.stateMachine.state,
      connected: this.connectionManager.isConnected(),
      transport: this.connectionManager.getActiveTransportName(),
      peerCount: this.connectionManager.getRoomSize(),
      rttMs: this.clockSync.rttMs,
    };
  }

  // ── Tab access ────────────────────────────────────────────────

  /**
   * The YouTube tab this peer is synchronizing, cached across calls.
   *
   * chrome.tabs.query is an async IPC round trip, and it previously ran on
   * every inbound command and every heartbeat tick. Caching the id keeps it out
   * of the hot path; a stale id simply fails to respond and is re-resolved.
   *
   * @returns {Promise<number|null>}
   * @private
   */
  async _getActiveTabId() {
    if (this._activeTabId !== null) return this._activeTabId;

    try {
      const tabs = await chrome.tabs.query({ url: '*://*.youtube.com/*' });
      if (!tabs || tabs.length === 0) return null;

      // Prefer a watch page; a bare youtube.com tab has no player to drive.
      const watchTab = tabs.find((t) => t.url && t.url.includes('/watch')) || tabs[0];
      this._activeTabId = watchTab.id;
      return this._activeTabId;
    } catch {
      return null;
    }
  }

  /** @private */
  _invalidateTabCache() {
    this._activeTabId = null;
  }

  /**
   * Ask a tab for its playback state.
   * @param {number} tabId
   * @returns {Promise<object|null>}
   * @private
   */
  async _queryTabState(tabId) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { action: 'GET_VIDEO_STATE' });
      if (response?.success && response.videoState?.videoId) {
        return response.videoState;
      }
    } catch {
      // Tab is gone, still loading, or has no content script yet.
    }
    return null;
  }

  /**
   * Playback state of the tab being synchronized.
   * @returns {Promise<{hasActiveTab: boolean, state: object|null}>}
   * @private
   */
  async _getTabVideoState() {
    const cachedId = await this._getActiveTabId();
    if (cachedId === null) return { hasActiveTab: false, state: null };

    const state = await this._queryTabState(cachedId);
    if (state) return { hasActiveTab: true, state };

    // The cached tab did not answer. Re-resolve once before giving up.
    this._invalidateTabCache();
    const freshId = await this._getActiveTabId();
    if (freshId === null || freshId === cachedId) {
      return { hasActiveTab: freshId !== null, state: null };
    }

    const freshState = await this._queryTabState(freshId);
    return { hasActiveTab: true, state: freshState };
  }

  // ── UI notification ───────────────────────────────────────────

  /**
   * Push status to the popup and the on-page overlay.
   *
   * The key must be `payload`: both popup.js and content-script.js read
   * `message.payload`, so sending it under any other name silently drops every
   * live update and leaves both UIs frozen on their initial render.
   *
   * @private
   */
  _broadcastStatusUpdate() {
    const status = this.getStatus();

    chrome.runtime
      .sendMessage({ action: 'UPDATE_STATUS', payload: status })
      .catch(() => {
        // No popup open. Expected.
      });

    this._getActiveTabId().then((tabId) => {
      if (tabId === null) return;
      chrome.tabs
        .sendMessage(tabId, { action: 'UPDATE_STATUS', payload: status })
        .catch(() => {
          this._invalidateTabCache();
        });
    });
  }

  // ── State machine helpers ─────────────────────────────────────

  /**
   * Start async work whose result nobody waits for, without letting a rejection
   * escape as an "Uncaught (in promise)" error on the extension's card.
   *
   * @param {Promise<*>} promise
   * @param {string} label - what failed, for the log line
   * @private
   */
  _fireAndForget(promise, label) {
    Promise.resolve(promise).catch((err) => {
      console.error(`[SyncEngine] ${label} failed:`, err);
    });
  }

  /**
   * Move to a state if the transition is legal, without throwing.
   *
   * Transitions are driven by network events whose ordering is not guaranteed,
   * so an illegal transition is a normal race rather than a bug worth throwing
   * over — and an exception here would abort whatever handler requested it.
   *
   * @param {string} target
   * @returns {boolean} whether the state changed
   * @private
   */
  _enterState(target) {
    if (this.stateMachine.state === target) return false;

    if (!this.stateMachine.canTransition(target)) {
      console.debug(
        `[SyncEngine] Skipping illegal transition ${this.stateMachine.state} → ${target}`
      );
      return false;
    }

    this.stateMachine.transition(target);
    this._broadcastStatusUpdate();
    return true;
  }

  /** @private */
  _scheduleDriftSettle() {
    this._clearDriftSettleTimer();
    this._driftSettleTimerId = setTimeout(() => {
      this._driftSettleTimerId = null;
      this._enterState(SyncState.SYNCED);
    }, 2000);
  }

  /** @private */
  _clearDriftSettleTimer() {
    if (this._driftSettleTimerId !== null) {
      clearTimeout(this._driftSettleTimerId);
      this._driftSettleTimerId = null;
    }
  }

  /** @private */
  _setupEventHandlers() {
    this.eventBus.on('connection:established', () => {
      this._enterState(SyncState.SYNCING);

      if (!this._isHost) {
        console.log('[SyncEngine] Joined room, requesting state...');
        this.sendAction('REQUEST_STATE', {});
      }

      this._startHeartbeat();
    });

    this.eventBus.on('connection:reconnecting', () => {
      this._enterState(SyncState.RECONNECTING);
    });

    this.eventBus.on('connection:closed', () => {
      this.stateMachine.reset();
      this._broadcastStatusUpdate();
      this._stopHeartbeat();
    });

    this.eventBus.on('transport:changed', ({ transport }) => {
      // RTT over a direct P2P path bears no relation to RTT over the relay,
      // so retaining samples across a switch would mis-compensate for as long
      // as they stay in the window.
      console.log(`[SyncEngine] Transport now ${transport}; resetting RTT samples`);
      this.clockSync.reset();
      this._broadcastStatusUpdate();
    });

    // Forward incoming remote commands to the YouTube tab.
    this.eventBus.on('command:received', async ({ command, senderId, type }) => {
      if (senderId === this._peerId) return; // Don't execute our own echo

      if (type === 'REQUEST_STATE') {
        if (this._isHost) {
          this._fireAndForget(this._broadcastRoomState(), 'room state broadcast');
        }
        return;
      }

      try {
        await this._routeCommandToTab(command, type);
      } catch (err) {
        console.error('[SyncEngine] Error routing command to tab:', err);
      }
    });
  }

  /**
   * Deliver a command to the YouTube tab, opening or navigating one if the
   * room is on a video this peer is not.
   * @private
   */
  async _routeCommandToTab(command, type) {
    const payload = command.payload || {};
    const wantsVideo = type === 'ROOM_STATE' && payload.videoId;

    let tabId = await this._getActiveTabId();

    if (tabId === null) {
      if (wantsVideo) {
        console.log(`[SyncEngine] No YouTube tab. Opening ${payload.videoId}`);
        const tab = await chrome.tabs.create({
          url: `https://www.youtube.com/watch?v=${payload.videoId}`,
        });
        this._activeTabId = tab.id;
      }
      return;
    }

    if (wantsVideo) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (tab && tab.url && !tab.url.includes('/watch')) {
        console.log(`[SyncEngine] Navigating tab ${tabId} to ${payload.videoId}`);
        await chrome.tabs.update(tabId, {
          url: `https://www.youtube.com/watch?v=${payload.videoId}`,
        });
        return;
      }
    }

    try {
      await chrome.tabs.sendMessage(tabId, {
        action: 'APPLY_COMMAND',
        payload: {
          type,
          command: this._compensate(type, command),
        },
      });
    } catch (err) {
      console.debug(`[SyncEngine] Tab ${tabId} did not accept command:`, err?.message);
      this._invalidateTabCache();
    }
  }

  /**
   * Advance a command's target position by the time it spent in flight.
   *
   * Without this, every peer applies the position the sender held when it hit
   * play — by the time the command arrives the sender has already moved on, so
   * the room settles a full network delay behind the person who acted. On a
   * relay hop between continents that is a visible third of a second before any
   * drift correction gets a chance to run.
   *
   * Only positions that are still advancing get compensated. A paused video's
   * position is frozen, so adding delay would push everyone *ahead* of the
   * sender — the exact bug this is meant to prevent, with the sign flipped.
   *
   * @param {string} type
   * @param {import('./commands/SyncCommand.js').SyncCommand} command
   * @returns {object} the serialized payload to send to the tab
   * @private
   */
  _compensate(type, command) {
    const serialized = command.serialize();

    if (typeof serialized.videoTime !== 'number' || !Number.isFinite(serialized.videoTime)) {
      return serialized;
    }

    // DRIFT is compensated where it is generated, against the heartbeat that
    // produced it. Compensating again here would double-count the delay.
    if (type === 'DRIFT') return serialized;

    let sourceIsPlaying;
    switch (type) {
      case 'PLAY':
      case 'FORCE_SYNC':
        sourceIsPlaying = true;
        break;
      case 'PAUSE':
        sourceIsPlaying = false;
        break;
      case 'SEEK':
      case 'ROOM_STATE':
        // The sender reports its own play state; assume playing when it is
        // absent, which is the common case for a scrub during playback.
        sourceIsPlaying = serialized.isPaused !== true;
        break;
      default:
        return serialized;
    }

    const originTimestamp = command.payload?.originTimestamp;

    return {
      ...serialized,
      videoTime: this.clockSync.compensateTime(
        serialized.videoTime,
        originTimestamp,
        sourceIsPlaying
      ),
    };
  }

  // ── Heartbeat ─────────────────────────────────────────────────

  /** @private */
  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatTick = 0;

    this._heartbeatIntervalId = setInterval(async () => {
      if (!this.connectionManager.isConnected()) return;

      this._heartbeatTick++;
      const { hasActiveTab, state } = await this._getTabVideoState();

      if (this._isHost) {
        if (!hasActiveTab) {
          console.log('[SyncEngine] Host has no YouTube tab. Relinquishing host.');
          this.disconnect();
          return;
        }

        if (state) {
          this.sendAction('HEARTBEAT', {
            videoId: state.videoId,
            videoTime: state.videoTime,
            isPaused: state.isPaused,
            hasActiveTab: true,
          });

          if (this.stateMachine.state === SyncState.SYNCING) {
            this._enterState(SyncState.SYNCED);
          }
        }
      } else {
        const ticksPerPing = Math.max(1, Math.round(PING_INTERVAL_MS / HEARTBEAT_INTERVAL_MS));
        if (this._heartbeatTick % ticksPerPing === 0) {
          // Also reports tab eligibility, which the server's host election reads.
          this.sendAction('PING', { hasActiveTab });
        }

        // Prefer the transport's own RTT when running P2P: it measures the ICE
        // candidate pair directly, without the service-worker wake-up and
        // message-passing overhead that an application-level PING absorbs.
        this._fireAndForget(this._sampleTransportRtt(), 'RTT sampling');
      }

      this._sendKeepaliveIfDue(hasActiveTab);
      this._fireAndForget(this._persistState(), 'state persist');
    }, HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Prove to the server that this peer is still here, over the WebSocket.
   *
   * Sent by host and client alike, and deliberately not routed through
   * `sendAction`: once the mesh is active that would put it on the DataChannel,
   * where the server cannot see it, which is the whole problem this solves.
   *
   * It carries no lamportClock. The peer's real clock has been advancing over
   * a channel the server never observed, so there is nothing to validate
   * against and any value would look like a jump.
   *
   * @param {boolean} hasActiveTab
   * @private
   */
  _sendKeepaliveIfDue(hasActiveTab) {
    const ticksPerKeepalive = Math.max(
      1,
      Math.round(KEEPALIVE_INTERVAL_MS / HEARTBEAT_INTERVAL_MS)
    );
    if (this._heartbeatTick % ticksPerKeepalive !== 0) return;

    this.connectionManager.sendViaRelay({
      type: 'KEEPALIVE',
      roomId: this._roomId,
      senderId: this._peerId,
      payload: { hasActiveTab, originTimestamp: Date.now() },
    });
  }

  /** @private */
  async _sampleTransportRtt() {
    const samples = await this.connectionManager.getRttSamples();
    if (samples.length === 0) return;

    // Host-driven sync: only the path to the host matters.
    const hostSample = this._hostId
      ? samples.find((s) => s.peerId === this._hostId)
      : null;

    if (hostSample) this.clockSync.recordRTT(hostSample.rttMs);
  }

  /** @private */
  _stopHeartbeat() {
    if (this._heartbeatIntervalId !== null) {
      clearInterval(this._heartbeatIntervalId);
      this._heartbeatIntervalId = null;
    }
  }

  /** @private */
  async _broadcastRoomState() {
    const { state } = await this._getTabVideoState();
    if (!state) return;

    console.log('[SyncEngine] Sending ROOM_STATE to peers', state);
    this.sendAction('ROOM_STATE', {
      videoId: state.videoId,
      videoTime: state.videoTime,
      isPaused: state.isPaused,
    });
  }

  /**
   * Persist critical state to chrome.storage.session.
   *
   * Throttled: this runs on every heartbeat tick, and an unthrottled write
   * every 2s is pure overhead when only the Lamport clock has moved.
   *
   * @param {boolean} [force=false] - Write immediately, ignoring the throttle
   * @private
   */
  async _persistState(force = false) {
    const now = Date.now();
    if (!force && now - this._lastPersistAt < PERSIST_INTERVAL_MS) return;

    this._lastPersistAt = now;
    await chrome.storage.session.set({
      peerId: this._peerId,
      roomId: this._roomId,
      isHost: this._isHost,
      lamportClock: this._lamportClock,
    });
  }

  /** @returns {string|null} */
  get peerId() { return this._peerId; }

  /** @returns {string|null} */
  get roomId() { return this._roomId; }

  /** @returns {boolean} */
  get isHost() { return this._isHost; }
}
