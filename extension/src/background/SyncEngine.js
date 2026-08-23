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
 * OOP Pillar: Singleton pattern — one SyncEngine per service worker,
 * acting as the Mediator between all subsystems.
 * 
 * OS Pillar: The service worker is an event-driven daemon; SyncEngine
 * persists its state in chrome.storage so it survives worker restarts.
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

    // Wire up ConnectionManager to route incoming transport messages to the engine
    this.connectionManager.onMessage(this.handleSyncMessage.bind(this));

    /** @type {string|null} This peer's ID (persisted in chrome.storage.session) */
    this._peerId = null;

    /** @type {string|null} Current room ID */
    this._roomId = null;

    /** @type {boolean} Whether this peer is the host */
    this._isHost = false;

    /** @type {number} Lamport logical clock */
    this._lamportClock = 0;

    /** @type {number|null} Interval ID for the heartbeat/ping cycle */
    this._heartbeatIntervalId = null;

    // Wire up internal event handlers
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

    // Persist the peer ID if newly generated
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
    const roomId = generateRoomCode();
    this._roomId = roomId;
    this._isHost = true;

    this.stateMachine.transition(SyncState.JOINING);

    await this.connectionManager.connect(roomId, this._peerId);
    await this._persistState();

    console.log(`[SyncEngine] Created room ${roomId} as host`);
    return { roomId, peerId: this._peerId };
  }

  /**
   * Join an existing room by code.
   * @param {string} roomId - 6-character room code
   * @returns {Promise<{roomId: string, peerId: string}>}
   */
  async joinRoom(roomId) {
    this._roomId = roomId.toUpperCase();
    this._isHost = false;

    this.stateMachine.transition(SyncState.JOINING);

    await this.connectionManager.connect(this._roomId, this._peerId);
    await this._persistState();

    console.log(`[SyncEngine] Joined room ${this._roomId}`);
    return { roomId: this._roomId, peerId: this._peerId };
  }

  /**
   * Ensure connection is active if we are in a room.
   * Called just-in-time before sending actions if the SW woke up from sleep.
   */
  async ensureConnection() {
    if (this._roomId && !this.connectionManager.isConnected()) {
      console.log(`[SyncEngine] Re-establishing connection for room ${this._roomId}...`);
      await this.connectionManager.connect(this._roomId, this._peerId);
    }
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
    if (this._roomId) {
      await this.connectionManager.disconnect();
    }

    this._roomId = null;
    this._isHost = false;
    this.stateMachine.reset();

    await this._persistState();
    console.log('[SyncEngine] Left room');
  }

  /**
   * Handle an incoming sync message from a peer.
   * @param {object} wireMessage - Full wire protocol message
   */
  handleSyncMessage(wireMessage) {
    // Update Lamport clock: max(local, received) + 1
    this._lamportClock = Math.max(this._lamportClock, wireMessage.lamportClock || 0) + 1;

    // Check for HOST_CHANGE broadcast from server
    if (wireMessage.type === 'HOST_CHANGE' && wireMessage.payload && wireMessage.payload.newHostId) {
      const newHostId = wireMessage.payload.newHostId;
      if (newHostId === this._peerId && !this._isHost) {
        console.log('[SyncEngine] I am the new host!');
        this._isHost = true;
        this._persistState();
        this._broadcastStatusUpdate();
        this._broadcastRoomState();
      } else if (newHostId !== this._peerId && this._isHost) {
        console.log('[SyncEngine] I am no longer the host.');
        this._isHost = false;
        this._persistState();
        this._broadcastStatusUpdate();
      }
      return;
    }

    if (wireMessage.type === 'PING') {
      if (this._isHost) {
        this.sendAction('PONG', { pingOriginTimestamp: wireMessage.payload.originTimestamp });
      }
      return;
    }

    if (wireMessage.type === 'PONG') {
      const rtt = Date.now() - wireMessage.payload.pingOriginTimestamp;
      this.clockSync.recordRTT(rtt);
      return;
    }

    if (wireMessage.type === 'HEARTBEAT') {
      if (!this._isHost) {
        this._getTabVideoState().then(({ state: vs }) => {
          if (vs && vs.videoId === wireMessage.payload.videoId) {
            const compensatedTime = this.clockSync.compensateTime(wireMessage.payload.videoTime, wireMessage.payload.originTimestamp);
            const drift = Math.abs(vs.videoTime - compensatedTime);
            const isStateMismatch = vs.isPaused !== wireMessage.payload.isPaused;
            
            // Trigger correction if time drift > 1.5s OR play/pause state is out of sync
            if (drift > 1.5 || isStateMismatch) {
              console.log(`[SyncEngine] Drift/Mismatch detected: local=${vs.videoTime.toFixed(2)}s (${vs.isPaused ? 'paused' : 'playing'}), host=${compensatedTime.toFixed(2)}s (${wireMessage.payload.isPaused ? 'paused' : 'playing'}). Applying correction.`);
              
              if (this.stateMachine.canTransition(SyncState.DRIFTING)) {
                this.stateMachine.transition(SyncState.DRIFTING);
              }
              
              // Emit local ROOM_STATE command to sync both time and play/pause state perfectly
              const correctionCmd = this.buildMessage('ROOM_STATE', { 
                videoId: wireMessage.payload.videoId,
                videoTime: compensatedTime,
                isPaused: wireMessage.payload.isPaused
              });
              
              this.eventBus.emit('command:received', {
                command: CommandFactory.fromWireMessage(correctionCmd),
                senderId: 'host-correction',
                type: 'ROOM_STATE'
              });
              
              // Settle back to SYNCED
              setTimeout(() => {
                if (this.stateMachine.canTransition(SyncState.SYNCED)) {
                  this.stateMachine.transition(SyncState.SYNCED);
                  this._broadcastStatusUpdate();
                }
              }, 2000);
            } else {
              // Drift within tolerance — promote to SYNCED
              if (this.stateMachine.state === SyncState.SYNCING && this.stateMachine.canTransition(SyncState.SYNCED)) {
                this.stateMachine.transition(SyncState.SYNCED);
                this._broadcastStatusUpdate();
              }
            }
          }
        });
      }
      return;
    }

    const command = CommandFactory.fromWireMessage(wireMessage);
    if (command) {
      // Emit so the content script can execute the command against the adapter
      this.eventBus.emit('command:received', {
        command,
        senderId: wireMessage.senderId,
        type: wireMessage.type
      });
    }
  }

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
    const message = this.buildMessage(type, payload);
    this.connectionManager.send(message);
  }

  handlePause(userId, videoTime) {
    this.sendAction('PAUSE', { videoTime });
  }

  handlePlay(userId, videoTime) {
    this.sendAction('PLAY', { videoTime });
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
    };
  }

  /**
   * Queries all YouTube tabs and returns the first valid watch tab state.
   * MV3 best practice using Promises for robust failure handling.
   * @private
   * @returns {Promise<{hasActiveTab: boolean, state: object|null}>}
   */
  async _getTabVideoState() {
    try {
      const tabs = await chrome.tabs.query({ url: '*://*.youtube.com/*' });
      if (!tabs || tabs.length === 0) return { hasActiveTab: false, state: null };

      for (const tab of tabs) {
        try {
          const response = await chrome.tabs.sendMessage(tab.id, { action: 'GET_VIDEO_STATE' });
          if (response && response.success && response.videoState && response.videoState.videoId) {
            return { hasActiveTab: true, state: response.videoState };
          }
        } catch (err) {
          // Expected if the tab is loading or not a watch page with an active adapter
        }
      }
      return { hasActiveTab: true, state: null };
    } catch (e) {
      return { hasActiveTab: false, state: null };
    }
  }

  /**
   * Broadcast status update to the extension UI (popup)
   * @private
   */
  _broadcastStatusUpdate() {
    chrome.runtime.sendMessage({ 
      action: 'UPDATE_STATUS', 
      status: this.getStatus() 
    }).catch(() => {
      // Ignore errors if popup is closed
    });
  }

  /** @private */
  _setupEventHandlers() {
    this.eventBus.on('connection:established', () => {
      if (this.stateMachine.canTransition(SyncState.SYNCING)) {
        this.stateMachine.transition(SyncState.SYNCING);
      }
      this._broadcastStatusUpdate();
      
      // If we just joined (not host), ask the host for the current state
      if (!this._isHost) {
        console.log('[SyncEngine] Joined room, requesting state...');
        this.sendAction('REQUEST_STATE', {});
      }
      
      this._startHeartbeat();
    });

    this.eventBus.on('connection:closed', () => {
      this.stateMachine.reset();
      this._broadcastStatusUpdate();
      this._stopHeartbeat();
    });

    // Forward incoming remote commands to the active YouTube tabs
    this.eventBus.on('command:received', async ({ command, senderId, type }) => {
      // Don't execute our own echoed commands
      if (senderId === this._peerId) return;

      if (type === 'REQUEST_STATE') {
        if (this._isHost) {
          this._broadcastRoomState();
        }
        return; // Don't forward REQUEST_STATE to content script
      }

      try {
        const tabs = await chrome.tabs.query({ url: '*://*.youtube.com/*' });
        
        // If we received ROOM_STATE with a videoId, ensure user is on the right video context.
        if (type === 'ROOM_STATE' && command.payload.videoId) {
          if (tabs.length === 0) {
            console.log(`[SyncEngine] No YouTube tabs open. Opening a new tab for video: ${command.payload.videoId}`);
            chrome.tabs.create({ url: `https://www.youtube.com/watch?v=${command.payload.videoId}` });
            return;
          }

          // Check if any tab is on a watch page.
          const watchTabs = tabs.filter(t => t.url && t.url.includes('/watch'));
          if (watchTabs.length === 0) {
            console.log(`[SyncEngine] No watch tabs found. Navigating tab ${tabs[0].id} to video: ${command.payload.videoId}`);
            chrome.tabs.update(tabs[0].id, {
              url: `https://www.youtube.com/watch?v=${command.payload.videoId}`
            });
            return;
          }
        }

        // Send to all tabs; ClientRoomStateCommand in the DOM handles internal SPA navigations
        for (const tab of tabs) {
          chrome.tabs.sendMessage(tab.id, {
            action: 'APPLY_COMMAND',
            payload: {
              type: type,
              command: command.serialize()
            }
          }).catch(err => {
            console.debug(`[SyncEngine] Could not send to tab ${tab.id}:`, err);
          });
        }
      } catch (err) {
        console.error('[SyncEngine] Error routing command to tabs:', err);
      }
    });
  }

  /** @private */
  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatIntervalId = setInterval(async () => {
      if (!this.connectionManager.isConnected()) return;
      
      const { hasActiveTab, state } = await this._getTabVideoState();

      if (this._isHost) {
        if (!hasActiveTab) {
          console.log('[SyncEngine] Host has no YouTube tabs. Relinquishing host by disconnecting.');
          this.disconnect();
          return;
        }

        if (state) {
          this.sendAction('HEARTBEAT', {
            videoId: state.videoId,
            videoTime: state.videoTime,
            isPaused: state.isPaused,
            hasActiveTab: true
          });

          if (this.stateMachine.state === SyncState.SYNCING && this.stateMachine.canTransition(SyncState.SYNCED)) {
            this.stateMachine.transition(SyncState.SYNCED);
            this._broadcastStatusUpdate();
          }
        }
      } else {
        // Client sends PING with hasActiveTab so the Server can track eligibility for host election
        this.sendAction('PING', { hasActiveTab });
      }

      // Periodically flush Lamport Clock to storage in case worker sleeps
      this._persistState();

    }, 5000);
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
    if (state) {
      console.log('[SyncEngine] Sending ROOM_STATE to peers', state);
      this.sendAction('ROOM_STATE', {
        videoId: state.videoId,
        videoTime: state.videoTime,
        isPaused: state.isPaused,
      });
    }
  }

  /**
   * Persist critical state to chrome.storage.session.
   * @private
   */
  async _persistState() {
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