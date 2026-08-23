/**
 * WebRTCTransport — Strategy Implementation
 * 
 * Establishes peer-to-peer DataChannel connections for low-latency
 * sync traffic. Only used when room size ≤ 5 users (to avoid O(N²)
 * mesh congestion).
 * 
 * Networks Pillar: Demonstrates ICE/STUN/TURN NAT traversal, SDP
 * offer/answer negotiation, and the WebRTC DataChannel API.
 * 
 * System Design Pillar: Congestion control — automatically falls back
 * to WebSocketTransport when P2P mesh would choke client bandwidth.
 */

import { Transport } from './Transport.js';

export class WebRTCTransport extends Transport {
  constructor() {
    super();
    this._roomId = null;
    this._localPeerId = null;
    
    /** @type {Map<string, RTCPeerConnection>} peerId → connection */
    this._peerConnections = new Map();

    /** @type {Map<string, RTCDataChannel>} peerId → data channel */
    this._dataChannels = new Map();

    /** @type {Map<string, RTCIceCandidateInit[]>} peerId → queued ICE candidates */
    this._iceCandidateQueues = new Map();

    /** @type {Function|null} */
    this._messageCallback = null;
    
    /** @type {Function|null} */
    this._signalingCallback = null;

    /** @type {boolean} */
    this._connected = false;

    /** @type {Function|null} Callback when DataChannel connectivity changes */
    this._onChannelStateChangeCallback = null;
    
    this._iceServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ];
  }

  /**
   * Set up basic room/peer ID context. 
   * Connections themselves are established on-demand via `connectToPeer`.
   * 
   * @param {string} roomId
   * @param {string} peerId
   * @returns {Promise<void>}
   */
  async connect(roomId, peerId) {
    this._roomId = roomId;
    this._localPeerId = peerId;
    console.log(`[WebRTCTransport] Initialized for room=${roomId}, peer=${peerId}`);
  }
  
  /**
   * Set callback for outgoing signaling messages (SDP/ICE).
   * ConnectionManager provides this to route them through WebSocket.
   * @param {Function} callback 
   */
  onSignaling(callback) {
    this._signalingCallback = callback;
  }

  /**
   * Check if we already have an active/pending connection to a peer
   * @param {string} peerId 
   * @returns {boolean}
   */
  hasPeerConnection(peerId) {
    return this._peerConnections.has(peerId);
  }

  /**
   * Initiate a connection to another peer (we are the offerer).
   * @param {string} peerId 
   */
  async connectToPeer(peerId) {
    if (this.hasPeerConnection(peerId)) {
      console.warn(`[WebRTCTransport] Connection to ${peerId} already exists or is pending.`);
      return;
    }
    
    console.log(`[WebRTCTransport] Initiating connection to ${peerId}`);
    const pc = this._createPeerConnection(peerId);
    
    // Create data channel (ordered: true, maxRetransmits: 3 as per blueprint)
    const dc = pc.createDataChannel('sync', {
      ordered: true,
      maxRetransmits: 3 
    });
    this._setupDataChannel(peerId, dc);
    
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      
      this._sendSignaling('SDP_OFFER', {
        targetPeerId: peerId,
        sdp: offer
      });
    } catch (err) {
      console.error(`[WebRTCTransport] Failed to create offer for ${peerId}:`, err);
      this.removePeer(peerId);
    }
  }

  /**
   * Handle incoming SDP offer (we are the answerer).
   * @param {string} senderId 
   * @param {RTCSessionDescriptionInit} sdp 
   */
  async handleOffer(senderId, sdp) {
    if (this.hasPeerConnection(senderId)) {
      console.warn(`[WebRTCTransport] Glare detected: received offer from ${senderId} but connection already exists. Resetting state.`);
      this.removePeer(senderId); // Clean slate to prevent negotiation locking
    }
    
    console.log(`[WebRTCTransport] Handling offer from ${senderId}`);
    const pc = this._createPeerConnection(senderId);
    
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      this._drainIceCandidates(senderId, pc); // Drain any candidates that arrived early

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      
      this._sendSignaling('SDP_ANSWER', {
        targetPeerId: senderId,
        sdp: answer
      });
    } catch (err) {
      console.error(`[WebRTCTransport] Failed to handle offer from ${senderId}:`, err);
      this.removePeer(senderId);
    }
  }

  /**
   * Handle incoming SDP answer.
   * @param {string} senderId 
   * @param {RTCSessionDescriptionInit} sdp 
   */
  async handleAnswer(senderId, sdp) {
    const pc = this._peerConnections.get(senderId);
    if (!pc) {
      console.warn(`[WebRTCTransport] Received answer from unknown peer ${senderId}`);
      return;
    }
    
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      console.log(`[WebRTCTransport] Set remote description (answer) from ${senderId}`);
      this._drainIceCandidates(senderId, pc);
    } catch (err) {
      console.error(`[WebRTCTransport] Failed to set remote answer from ${senderId}:`, err);
    }
  }

  /**
   * Handle incoming ICE candidate.
   * Prevents race conditions by queueing candidates if the remote description isn't set yet.
   * @param {string} senderId 
   * @param {RTCIceCandidateInit} candidate 
   */
  async handleIceCandidate(senderId, candidate) {
    const pc = this._peerConnections.get(senderId);
    if (!pc) {
      console.warn(`[WebRTCTransport] Received ICE candidate from unknown peer ${senderId}`);
      return;
    }
    
    // WebRTC race condition fix: Queue candidate if remote description is absent
    if (!pc.remoteDescription || !pc.remoteDescription.type) {
      if (!this._iceCandidateQueues.has(senderId)) {
        this._iceCandidateQueues.set(senderId, []);
      }
      this._iceCandidateQueues.get(senderId).push(candidate);
      return;
    }
    
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.error(`[WebRTCTransport] Failed to add ICE candidate from ${senderId}:`, err);
    }
  }

  /**
   * Drains early ICE candidates queued before the remote SDP was processed.
   * @param {string} peerId 
   * @param {RTCPeerConnection} pc 
   */
  async _drainIceCandidates(peerId, pc) {
    const queue = this._iceCandidateQueues.get(peerId);
    if (queue && queue.length > 0) {
      console.log(`[WebRTCTransport] Draining ${queue.length} queued ICE candidates for ${peerId}`);
      for (const candidate of queue) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
          console.error(`[WebRTCTransport] Failed to add queued ICE candidate from ${peerId}:`, err);
        }
      }
      this._iceCandidateQueues.delete(peerId);
    }
  }

  /**
   * Remove a peer's connection and data channel securely.
   * @param {string} peerId 
   */
  removePeer(peerId) {
    const dc = this._dataChannels.get(peerId);
    if (dc) {
      dc.onopen = null;
      dc.onclose = null;
      dc.onmessage = null;
      dc.onerror = null;
      dc.close();
      this._dataChannels.delete(peerId);
    }
    
    const pc = this._peerConnections.get(peerId);
    if (pc) {
      pc.onicecandidate = null;
      pc.ondatachannel = null;
      pc.oniceconnectionstatechange = null;
      pc.onconnectionstatechange = null;
      pc.close();
      this._peerConnections.delete(peerId);
    }

    this._iceCandidateQueues.delete(peerId);
    
    console.log(`[WebRTCTransport] Removed peer ${peerId}`);
    this._evaluateConnectedState();
  }

  /**
   * @param {object} message
   */
  send(message) {
    const payload = JSON.stringify(message);
    let sentCount = 0;
    
    for (const [peerId, dc] of this._dataChannels.entries()) {
      if (dc.readyState === 'open') {
        try {
          dc.send(payload);
          sentCount++;
        } catch (err) {
          console.error(`[WebRTCTransport] Failed to send to ${peerId}:`, err);
        }
      }
    }
    
    if (sentCount === 0) {
      console.warn('[WebRTCTransport] send() called but no data channels are open');
    }
  }

  /**
   * @param {Function} callback
   */
  onMessage(callback) {
    this._messageCallback = callback;
  }

  /**
   * Returns true if we have AT LEAST ONE open data channel.
   * ConnectionManager will enforce if we have ENOUGH channels.
   * @returns {boolean}
   */
  isConnected() {
    return this._connected;
  }
  
  /**
   * Return number of open data channels.
   * @returns {number}
   */
  getOpenChannelCount() {
    let count = 0;
    for (const dc of this._dataChannels.values()) {
      if (dc.readyState === 'open') count++;
    }
    return count;
  }

  /**
   * @returns {Promise<void>}
   */
  async disconnect() {
    console.log('[WebRTCTransport] Disconnecting all peers');
    for (const peerId of this._peerConnections.keys()) {
      this.removePeer(peerId);
    }
    this._connected = false;
  }

  /**
   * @param {string} peerId 
   * @returns {RTCPeerConnection}
   */
  _createPeerConnection(peerId) {
    const pc = new RTCPeerConnection({ iceServers: this._iceServers });
    this._peerConnections.set(peerId, pc);
    
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this._sendSignaling('ICE_CANDIDATE', {
          targetPeerId: peerId,
          candidate: event.candidate
        });
      }
    };
    
    pc.ondatachannel = (event) => {
      console.log(`[WebRTCTransport] Received incoming DataChannel from ${peerId}`);
      this._setupDataChannel(peerId, event.channel);
    };
    
    // Monitor ICE connection state
    pc.oniceconnectionstatechange = () => {
      console.log(`[WebRTCTransport] ICE state for ${peerId}: ${pc.iceConnectionState}`);
      if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'closed') {
        this.removePeer(peerId);
      }
    };

    // Monitor holistic Connection state (modern standard)
    pc.onconnectionstatechange = () => {
      console.log(`[WebRTCTransport] Connection state for ${peerId}: ${pc.connectionState}`);
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.removePeer(peerId);
      }
    };
    
    return pc;
  }

  /**
   * @param {string} peerId 
   * @param {RTCDataChannel} dc 
   */
  _setupDataChannel(peerId, dc) {
    this._dataChannels.set(peerId, dc);
    
    dc.onopen = () => {
      console.log(`[WebRTCTransport] DataChannel open for ${peerId}`);
      this._evaluateConnectedState();
    };
    
    dc.onclose = () => {
      console.log(`[WebRTCTransport] DataChannel closed for ${peerId}`);
      this.removePeer(peerId);
    };

    dc.onerror = (error) => {
      console.error(`[WebRTCTransport] DataChannel error for ${peerId}:`, error);
    };
    
    dc.onmessage = (event) => {
      if (this._messageCallback) {
        try {
          const message = JSON.parse(event.data);
          this._messageCallback(message);
        } catch (err) {
          console.error(`[WebRTCTransport] Failed to parse message from ${peerId}:`, err);
        }
      }
    };
  }
  
  _evaluateConnectedState() {
    const prev = this._connected;
    this._connected = this.getOpenChannelCount() > 0;
    if (prev !== this._connected && this._onChannelStateChangeCallback) {
      this._onChannelStateChangeCallback();
    }
  }

  /**
   * Register a callback for DataChannel connectivity changes.
   * Used by ConnectionManager to trigger transport evaluation.
   * @param {Function} callback
   */
  onChannelStateChange(callback) {
    this._onChannelStateChangeCallback = callback;
  }

  /**
   * @param {string} type 
   * @param {object} payload 
   */
  _sendSignaling(type, payload) {
    if (this._signalingCallback) {
      this._signalingCallback({
        type,
        roomId: this._roomId,
        senderId: this._localPeerId,
        lamportClock: 0, // Structural messaging bypassing application lamport logic
        payload
      });
    } else {
      console.warn('[WebRTCTransport] No signaling callback registered');
    }
  }
}