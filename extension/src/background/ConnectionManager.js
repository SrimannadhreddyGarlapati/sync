/**
 * ConnectionManager — Singleton
 * 
 * Manages the lifecycle of transport connections. Implements the hybrid
 * transport strategy: tries WebRTC first for rooms ≤ 5 users, falls back
 * to WebSocket relay otherwise.
 * 
 * System Design Pillar: Encapsulates the transport selection logic and
 * P2P-to-relay fallback, presenting a single unified API to SyncEngine.
 * 
 * OOP Pillar: Singleton pattern — only one ConnectionManager exists per
 * service worker instance, managing all peer connections.
 */

import { EventBus } from './EventBus.js';
import { WebSocketTransport } from './transports/WebSocketTransport.js';
import { WebRTCTransport } from './transports/WebRTCTransport.js';

/** Maximum room size for P2P mesh before falling back to relay */
const P2P_THRESHOLD = 5;

export class ConnectionManager {
  /**
   * @param {EventBus} eventBus - Shared event bus
   */
  constructor(eventBus) {
    /** @type {EventBus} */
    this._eventBus = eventBus;

    /** @type {import('./transports/Transport.js').Transport|null} */
    this._activeTransport = null;

    /** @type {WebSocketTransport} Always available for signaling */
    this._wsTransport = new WebSocketTransport();

    /** @type {WebRTCTransport} Used for P2P in small rooms */
    this._rtcTransport = new WebRTCTransport();

    /** @type {string|null} Current room ID */
    this._roomId = null;

    /** @type {string|null} This peer's unique ID */
    this._peerId = null;

    /** @type {number} Current room size */
    this._roomSize = 0;
    
    /** @type {Function|null} App-level message callback (SyncEngine) */
    this._appMessageCallback = null;

    /** @type {number|null} Debounce timer for transport evaluation */
    this._transportEvalTimerId = null;
    
    // Wire up WebRTC signaling to go out over WebSocket
    this._rtcTransport.onSignaling((msg) => {
      if (this._wsTransport.isConnected()) {
        this._wsTransport.send(msg);
      }
    });

    // Handle incoming messages from both transports
    this._wsTransport.onMessage(this._handleWebSocketMessage.bind(this));
    this._rtcTransport.onMessage(this._handleWebRTCMessage.bind(this));

    // Wire up WS unexpected-close to emit reconnecting event
    this._wsTransport.onClose(() => {
      console.warn('[ConnectionManager] WebSocket dropped. Transport will auto-reconnect.');
      this._eventBus.emit('connection:reconnecting');
    });

    // Wire up WebRTC DataChannel state changes to trigger transport evaluation
    this._rtcTransport.onChannelStateChange(() => {
      this._scheduleTransportEval();
    });
  }

  /**
   * Connect to a room. Chooses the appropriate transport strategy.
   * @param {string} roomId
   * @param {string} peerId
   * @returns {Promise<void>}
   */
  async connect(roomId, peerId) {
    this._roomId = roomId;
    this._peerId = peerId;

    // WebSocket is always established first (signaling + fallback)
    await this._wsTransport.connect(roomId, peerId);
    await this._rtcTransport.connect(roomId, peerId);

    // Start with WebSocket as active transport
    this._activeTransport = this._wsTransport;

    this._eventBus.emit('connection:established', { roomId, peerId });
    console.log(`[ConnectionManager] Connected to room ${roomId} as ${peerId}`);
  }

  /**
   * Send a message via the active transport.
   * @param {object} message - Wire protocol message
   */
  send(message) {
    // We only route data/sync commands through here.
    // Signaling (SDP/ICE) is handled internally via _rtcTransport.onSignaling
    
    // Fallback: If WebRTC is active but not fully connected, send via WebSocket
    if (this._activeTransport === this._rtcTransport && !this._rtcTransport.isConnected()) {
        this._wsTransport.send(message);
        return;
    }
    
    if (this._activeTransport) {
      this._activeTransport.send(message);
    }
  }

  /**
   * Register a handler for incoming messages.
   * @param {Function} callback
   */
  onMessage(callback) {
    this._appMessageCallback = callback;
  }
  
  _handleWebSocketMessage(message) {
    const { type, payload, senderId } = message;
    
    // Process WebRTC signaling messages
    if (type === 'SDP_OFFER') {
      this._rtcTransport.handleOffer(senderId, payload.sdp);
      return; // Consume
    } else if (type === 'SDP_ANSWER') {
      this._rtcTransport.handleAnswer(senderId, payload.sdp);
      return; // Consume
    } else if (type === 'ICE_CANDIDATE') {
      this._rtcTransport.handleIceCandidate(senderId, payload.candidate);
      return; // Consume
    }
    
    // Handle room size updates
    if (type === 'ROOM_STATE' && payload.peers) {
      this.updateRoomSize(payload.peers.length);
      // NOTE: We do NOT initiate WebRTC connections here to avoid glare.
      // Only existing peers in the room initiate connections when they receive
      // a JOIN event for the new peer. The joining peer remains passive.
    } else if (type === 'JOIN') {
      // Fix: Safely handle missing peerId in payload or malformed join envelopes
      const joiningPeerId = payload?.peerId || senderId;
      this.updateRoomSize(this._roomSize + 1);
      
      // Existing peers initiate offer to the new joiner
      if (this._roomSize <= P2P_THRESHOLD && joiningPeerId && joiningPeerId !== this._peerId) {
        this._rtcTransport.connectToPeer(joiningPeerId);
      }
    } else if (type === 'LEAVE') {
      this.updateRoomSize(Math.max(1, this._roomSize - 1));
      if (payload?.peerId || senderId) {
        this._rtcTransport.removePeer(payload?.peerId || senderId);
      }
    }
    
    // Forward all other messages (and ROOM_STATE/JOIN/LEAVE) to SyncEngine
    // ONLY if WebSocket is the active transport, OR if it's a structural message.
    // Sync commands (PLAY, PAUSE) should be ignored on WS if WebRTC is active,
    // to avoid duplicates, unless WebRTC is struggling.
    const isStructural = ['JOIN', 'LEAVE', 'HOST_CHANGE', 'ROOM_STATE', 'REQUEST_STATE', 'PING', 'PONG', 'HEARTBEAT'].includes(type);
    
    if (this._activeTransport === this._wsTransport || isStructural) {
      if (this._appMessageCallback) {
        this._appMessageCallback(message);
      }
    }
  }
  
  _handleWebRTCMessage(message) {
    // If WebRTC isn't the active transport yet, we can optionally buffer or just process.
    // For simplicity, we process it. Data channels are reliable.
    if (this._appMessageCallback) {
      this._appMessageCallback(message);
    }
  }

  /**
   * Update the room size and potentially switch transport strategy.
   * @param {number} size - Number of peers in the room
   */
  updateRoomSize(size) {
    const previousSize = this._roomSize;
    this._roomSize = size;

    if (previousSize <= P2P_THRESHOLD && size > P2P_THRESHOLD) {
      console.log(`[ConnectionManager] Room grew to ${size} — switching to relay fallback`);
      this._activeTransport = this._wsTransport;
      this._eventBus.emit('transport:downgraded', { transport: 'WebSocket' });
    }
    
    this._scheduleTransportEval();
  }
  
  /**
   * Debounced transport evaluation. Called when DataChannel state changes
   * or room size changes, instead of polling every 2s.
   * @private
   */
  _scheduleTransportEval() {
    if (this._transportEvalTimerId !== null) {
      clearTimeout(this._transportEvalTimerId);
    }
    this._transportEvalTimerId = setTimeout(() => {
      this._transportEvalTimerId = null;
      this._evaluateTransportState();
    }, 300); // 300ms debounce to let ICE/DataChannel settle
  }

  /** @private */
  _evaluateTransportState() {
    if (!this._roomId) return;
    
    const expectedChannels = Math.max(0, this._roomSize - 1);
    const openChannels = this._rtcTransport.getOpenChannelCount();
    
    if (this._roomSize > 1 && this._roomSize <= P2P_THRESHOLD && expectedChannels > 0 && openChannels >= expectedChannels) {
      if (this._activeTransport !== this._rtcTransport) {
        console.log(`[ConnectionManager] Upgrading to WebRTC P2P transport (${openChannels}/${expectedChannels} connected)`);
        this._activeTransport = this._rtcTransport;
        this._eventBus.emit('transport:upgraded', { transport: 'WebRTC' });
      }
    } else {
      if (this._activeTransport === this._rtcTransport && openChannels < expectedChannels) {
        console.log(`[ConnectionManager] Downgrading to WebSocket relay (${openChannels}/${expectedChannels} connected)`);
        this._activeTransport = this._wsTransport;
        this._eventBus.emit('transport:downgraded', { transport: 'WebSocket' });
      }
    }
  }

  /**
   * Disconnect from the current room.
   * @returns {Promise<void>}
   */
  async disconnect() {
    // Cancel pending transport evaluation
    if (this._transportEvalTimerId !== null) {
      clearTimeout(this._transportEvalTimerId);
      this._transportEvalTimerId = null;
    }

    await this._rtcTransport.disconnect();
    await this._wsTransport.disconnect();
    
    this._activeTransport = null;
    this._roomId = null;
    this._peerId = null;
    this._roomSize = 0;

    this._eventBus.emit('connection:closed');
    console.log('[ConnectionManager] Disconnected');
  }

  /**
   * @returns {boolean}
   */
  isConnected() {
    // As long as WebSocket is connected, we are connected to the room.
    return this._wsTransport.isConnected();
  }

  /**
   * @returns {string|null}
   */
  get roomId() {
    return this._roomId;
  }

  /**
   * @returns {string|null}
   */
  get peerId() {
    return this._peerId;
  }
}