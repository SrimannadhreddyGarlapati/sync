/**
 * ConnectionManager — Singleton
 *
 * Manages the lifecycle of transport connections and implements the hybrid
 * transport strategy: WebRTC P2P for rooms of 5 or fewer, WebSocket relay
 * otherwise (or whenever the mesh fails to come up).
 *
 * System Design Pillar: Encapsulates transport selection and the P2P-to-relay
 * fallback, presenting one unified API to SyncEngine.
 *
 * OOP Pillar: Singleton — one ConnectionManager per service worker instance,
 * owning all peer connections.
 */

import { EventBus } from './EventBus.js';
import { WebSocketTransport } from './transports/WebSocketTransport.js';
import { WebRTCTransport } from './transports/WebRTCTransport.js';

/** Maximum room size for a P2P mesh before falling back to relay. */
const P2P_THRESHOLD = 5;

/** Settling time before acting on a transport-state change. */
const TRANSPORT_EVAL_DEBOUNCE_MS = 300;

/** Minimum gap between attempts to rebuild a mesh that failed to form. */
const MESH_REPAIR_INTERVAL_MS = 10000;

/**
 * Structural messages are delivered to the application regardless of which
 * transport is active, because they describe the room rather than playback.
 */
const STRUCTURAL_TYPES = new Set([
  'JOIN', 'LEAVE', 'HOST_CHANGE', 'ROOM_STATE', 'REQUEST_STATE',
  'PING', 'PONG', 'HEARTBEAT',
]);

/** Handled entirely inside this class; never forwarded to the application. */
const SIGNALING_TYPES = new Set(['SDP_OFFER', 'SDP_ANSWER', 'ICE_CANDIDATE']);

export class ConnectionManager {
  /**
   * @param {EventBus} eventBus - Shared event bus
   */
  constructor(eventBus) {
    /** @type {EventBus} */
    this._eventBus = eventBus;

    /** @type {import('./transports/Transport.js').Transport|null} */
    this._activeTransport = null;

    /** @type {WebSocketTransport} Always connected: signaling plus fallback */
    this._wsTransport = new WebSocketTransport();

    /** @type {WebRTCTransport} P2P for small rooms */
    this._rtcTransport = new WebRTCTransport();

    /** @type {string|null} */
    this._roomId = null;

    /** @type {string|null} */
    this._peerId = null;

    /**
     * Every peer currently in the room, this one included.
     *
     * Derived from the server's authoritative ROOM_STATE list and kept current
     * by JOIN and LEAVE. Tracking the actual identities rather than a running
     * count means a duplicate JOIN or a missed LEAVE cannot leave the room size
     * permanently wrong — which previously made the transport decision drift
     * out of step with reality.
     *
     * @type {Set<string>}
     */
    this._peers = new Set();

    /** @type {Function|null} Application message sink (SyncEngine) */
    this._appMessageCallback = null;

    /** @type {number|null} Debounce timer for transport evaluation */
    this._transportEvalTimerId = null;

    /** @type {number} When the mesh was last re-synced after failing to form */
    this._lastMeshRepairAt = 0;

    // Route WebRTC signaling out over the WebSocket. The WebSocket is kept
    // connected for the whole session precisely so this path always exists.
    this._rtcTransport.onSignaling((msg) => {
      if (this._wsTransport.isConnected()) {
        this._wsTransport.send(msg);
      } else {
        console.warn('[ConnectionManager] Dropping signaling message: WebSocket down');
      }
    });

    this._wsTransport.onMessage(this._handleWebSocketMessage.bind(this));
    this._rtcTransport.onMessage(this._handleWebRTCMessage.bind(this));

    this._wsTransport.onClose(() => {
      console.warn('[ConnectionManager] WebSocket dropped. Transport will auto-reconnect.');
      this._eventBus.emit('connection:reconnecting');
    });

    this._wsTransport.onReopen(() => {
      console.log('[ConnectionManager] WebSocket restored.');

      // The server treats the new socket as a fresh join and will send a
      // ROOM_STATE, but the mesh built for the old socket is stale: peers may
      // have come and gone. Re-announcing establishment makes the engine
      // request state and resume its heartbeat.
      this._eventBus.emit('connection:established', {
        roomId: this._roomId,
        peerId: this._peerId,
        reconnected: true,
      });
    });

    this._rtcTransport.onChannelStateChange(() => {
      this._scheduleTransportEval();
    });
  }

  /**
   * Connect to a room.
   * @param {string} roomId
   * @param {string} peerId
   * @returns {Promise<void>}
   */
  async connect(roomId, peerId) {
    this._roomId = roomId;
    this._peerId = peerId;
    this._peers = new Set([peerId]);

    // Start on the relay. The mesh is only adopted once it is demonstrably up.
    this._activeTransport = this._wsTransport;

    // The WebRTC host must know its own identity BEFORE the socket opens.
    //
    // The server sends ROOM_STATE and broadcasts JOIN the instant a socket
    // connects. Opening the socket first lets those arrive while this call is
    // still awaiting its ICE-server fetch, so syncPeers reaches an
    // uninitialised offscreen document. There, a null local peer ID means the
    // peer cannot filter itself out of the room list, and — because "null"
    // sorts before "peer_..." — every peer concludes it is the offerer. Both
    // sides then offer, both see a collision, and no channel ever opens.
    await this._rtcTransport.connect(roomId, peerId);

    // WebSocket second: it carries signaling and is the fallback data path.
    await this._wsTransport.connect(roomId, peerId);

    this._eventBus.emit('connection:established', { roomId, peerId });
    console.log(`[ConnectionManager] Connected to room ${roomId} as ${peerId}`);
  }

  /**
   * Send a message over the active transport.
   * @param {object} message - Wire protocol message
   */
  send(message) {
    // Signaling never comes through here; it goes out via the onSignaling hook.
    if (this._activeTransport === this._rtcTransport && !this._rtcTransport.isConnected()) {
      // The mesh dropped between evaluations. Do not lose the command.
      this._wsTransport.send(message);
      return;
    }

    if (this._activeTransport) {
      this._activeTransport.send(message);
    }
  }

  /**
   * Send a message over the WebSocket specifically, whatever transport is active.
   *
   * Once the mesh is carrying playback, `send` routes everything to the
   * DataChannel and the WebSocket goes completely silent — which is
   * indistinguishable, from the server's side, from a dead connection. The
   * socket is still needed for signaling and as the fallback, so it has to be
   * visibly alive even while nothing else is using it.
   *
   * @param {object} message - Wire protocol message
   */
  sendViaRelay(message) {
    this._wsTransport.send(message);
  }

  /**
   * Register a handler for incoming messages.
   * @param {Function} callback
   */
  onMessage(callback) {
    this._appMessageCallback = callback;
  }

  /**
   * The transport currently carrying playback commands.
   * @returns {'WebRTC'|'WebSocket'|'none'}
   */
  getActiveTransportName() {
    if (this._activeTransport === this._rtcTransport) return 'WebRTC';
    if (this._activeTransport === this._wsTransport) return 'WebSocket';
    return 'none';
  }

  /** @returns {number} */
  getRoomSize() {
    return this._peers.size;
  }

  /**
   * Peer-to-peer RTT samples, when the mesh is carrying traffic.
   * @returns {Promise<{peerId: string, rttMs: number}[]>}
   */
  async getRttSamples() {
    if (this._activeTransport !== this._rtcTransport) return [];
    return this._rtcTransport.getRttSamples();
  }

  // ── Inbound routing ───────────────────────────────────────────

  /** @private */
  _handleWebSocketMessage(message) {
    const { type, payload, senderId } = message;

    if (SIGNALING_TYPES.has(type)) {
      this._consumeSignaling(type, senderId, payload);
      return;
    }

    this._updateMembership(type, senderId, payload);

    // Playback commands arriving over the WebSocket are ignored while the mesh
    // is active, so a message that crosses both paths is not applied twice.
    if (this._activeTransport === this._wsTransport || STRUCTURAL_TYPES.has(type)) {
      if (this._appMessageCallback) this._appMessageCallback(message);
    }
  }

  /** @private */
  _handleWebRTCMessage(message) {
    if (this._appMessageCallback) this._appMessageCallback(message);
  }

  /**
   * Hand an SDP or ICE message to the peer connection host.
   * @private
   */
  _consumeSignaling(type, senderId, payload) {
    if (!payload) return;

    switch (type) {
      case 'SDP_OFFER':
        this._rtcTransport.handleOffer(senderId, payload.sdp);
        break;
      case 'SDP_ANSWER':
        this._rtcTransport.handleAnswer(senderId, payload.sdp);
        break;
      case 'ICE_CANDIDATE':
        this._rtcTransport.handleIceCandidate(senderId, payload.candidate);
        break;
      default:
        break;
    }
  }

  /**
   * Keep the peer set in step with the room, then reconcile the mesh.
   * @private
   */
  _updateMembership(type, senderId, payload) {
    let changed = false;

    if (type === 'ROOM_STATE' && Array.isArray(payload?.peers)) {
      // The server's list is authoritative; adopt it wholesale.
      const next = new Set(payload.peers);
      if (this._peerId) next.add(this._peerId);

      if (!this._setsEqual(next, this._peers)) {
        this._peers = next;
        changed = true;
      }
    } else if (type === 'JOIN') {
      const joiningPeerId = payload?.peerId || senderId;
      if (joiningPeerId && !this._peers.has(joiningPeerId)) {
        this._peers.add(joiningPeerId);
        changed = true;
      }
    } else if (type === 'LEAVE') {
      const leavingPeerId = payload?.peerId || senderId;
      if (leavingPeerId && this._peers.delete(leavingPeerId)) {
        changed = true;
        this._rtcTransport.removePeer(leavingPeerId);
      }
    }

    if (!changed) return;

    console.log(`[ConnectionManager] Room membership: ${this._peers.size} peer(s)`);

    // Reconcile the mesh only while the room is small enough to warrant one.
    // Above the threshold, tearing the mesh down frees the client's uplink.
    if (this._peers.size <= P2P_THRESHOLD) {
      this._rtcTransport.syncPeers(Array.from(this._peers));
    } else {
      this._rtcTransport.syncPeers([]);
    }

    this._scheduleTransportEval();
  }

  /** @private */
  _setsEqual(a, b) {
    if (a.size !== b.size) return false;
    for (const item of a) {
      if (!b.has(item)) return false;
    }
    return true;
  }

  // ── Transport selection ───────────────────────────────────────

  /**
   * Debounced re-evaluation, so a burst of channel-state changes during ICE
   * settles into a single decision.
   * @private
   */
  _scheduleTransportEval() {
    if (this._transportEvalTimerId !== null) {
      clearTimeout(this._transportEvalTimerId);
    }
    this._transportEvalTimerId = setTimeout(() => {
      this._transportEvalTimerId = null;
      this._evaluateTransportState();
    }, TRANSPORT_EVAL_DEBOUNCE_MS);
  }

  /**
   * Adopt the mesh only when it is fully formed, and abandon it the moment it
   * is not. A partial mesh is worse than the relay: some peers would receive
   * commands and others would not.
   * @private
   */
  _evaluateTransportState() {
    if (!this._roomId) return;

    const roomSize = this._peers.size;
    const expectedChannels = Math.max(0, roomSize - 1);
    const openChannels = this._rtcTransport.getOpenChannelCount();

    const meshIsViable =
      roomSize > 1 &&
      roomSize <= P2P_THRESHOLD &&
      expectedChannels > 0 &&
      openChannels >= expectedChannels;

    // A mesh that should exist but has no channels at all means the peer list
    // never reached the WebRTC host, or every negotiation failed. Nothing else
    // will re-drive it: syncPeers is only issued when membership *changes*, and
    // a stable room produces no further changes. Re-issue it, rate-limited so a
    // permanently unreachable peer cannot turn this into a retry loop.
    if (
      roomSize > 1 &&
      roomSize <= P2P_THRESHOLD &&
      openChannels === 0 &&
      Date.now() - this._lastMeshRepairAt > MESH_REPAIR_INTERVAL_MS
    ) {
      this._lastMeshRepairAt = Date.now();
      console.log('[ConnectionManager] Mesh expected but absent; re-syncing peers');
      this._rtcTransport.syncPeers(Array.from(this._peers));
    }

    if (meshIsViable) {
      if (this._activeTransport !== this._rtcTransport) {
        console.log(
          `[ConnectionManager] Upgrading to WebRTC P2P ` +
          `(${openChannels}/${expectedChannels} channels open)`
        );
        this._activeTransport = this._rtcTransport;
        this._eventBus.emit('transport:changed', { transport: 'WebRTC' });
        this._eventBus.emit('transport:upgraded', { transport: 'WebRTC' });
      }
      return;
    }

    if (this._activeTransport !== this._wsTransport) {
      console.log(
        `[ConnectionManager] Falling back to WebSocket relay ` +
        `(${openChannels}/${expectedChannels} channels open, room=${roomSize})`
      );
      this._activeTransport = this._wsTransport;
      this._eventBus.emit('transport:changed', { transport: 'WebSocket' });
      this._eventBus.emit('transport:downgraded', { transport: 'WebSocket' });
    }
  }

  /**
   * Disconnect from the current room.
   * @returns {Promise<void>}
   */
  async disconnect() {
    if (this._transportEvalTimerId !== null) {
      clearTimeout(this._transportEvalTimerId);
      this._transportEvalTimerId = null;
    }

    await this._rtcTransport.disconnect();
    await this._wsTransport.disconnect();

    this._activeTransport = null;
    this._roomId = null;
    this._peerId = null;
    this._peers = new Set();

    this._eventBus.emit('connection:closed');
    console.log('[ConnectionManager] Disconnected');
  }

  /**
   * The room is reachable as long as the WebSocket is up, regardless of mesh state.
   * @returns {boolean}
   */
  isConnected() {
    return this._wsTransport.isConnected();
  }

  /** @returns {string|null} */
  get roomId() {
    return this._roomId;
  }

  /** @returns {string|null} */
  get peerId() {
    return this._peerId;
  }
}
