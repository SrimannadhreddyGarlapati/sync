/**
 * WebRTCTransport — Strategy Implementation
 *
 * Peer-to-peer DataChannel transport for low-latency sync traffic. Used only
 * when the room is small enough (≤ 5 peers) that a full mesh does not choke
 * client uplink with O(N²) sends.
 *
 * Where the connections actually live
 * -----------------------------------
 * Not here. WebRTC's interfaces are `[Exposed=Window]`, so an MV3 service
 * worker cannot construct an RTCPeerConnection — the call throws
 * ReferenceError. The connections are hosted in an offscreen document
 * (`src/offscreen/`), and this class is the service worker's proxy to it:
 * it owns the offscreen document's lifecycle, forwards commands, and turns the
 * events coming back into the Transport interface that ConnectionManager
 * expects. Every peer connection therefore survives a service-worker restart,
 * because the offscreen document outlives the worker.
 *
 * Networks Pillar: ICE/STUN/TURN NAT traversal, SDP offer/answer negotiation,
 * and the WebRTC DataChannel API.
 *
 * System Design Pillar: Congestion control — falls back to WebSocketTransport
 * when a P2P mesh would be the wrong shape for the room.
 */

import { Transport } from './Transport.js';
import { ICE_ENDPOINT } from '../config.js';

/** Path to the offscreen document, relative to the extension root. */
const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';

/** Messages this class sends to the offscreen document. */
const OFFSCREEN_TARGET = 'synctube-offscreen';

/** Messages the offscreen document sends back. */
const WORKER_TARGET = 'synctube-worker';

/** Used until (or unless) the server hands over a better list. */
const FALLBACK_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

/** ICE servers are cached for this long so a rejoin does not refetch. */
const ICE_CACHE_TTL_MS = 30 * 60 * 1000;

/**
 * How long to wait for ICE servers before giving up and using STUN.
 *
 * This fetch sits in front of joining a room, because the offscreen document
 * must know its identity before the socket can deliver a peer list. A free-tier
 * server waking from idle can take a minute to answer, and making someone wait
 * that long to join — when STUN alone would have worked on their network — is a
 * far worse trade than losing TURN for one session.
 */
const ICE_FETCH_TIMEOUT_MS = 8000;

export class WebRTCTransport extends Transport {
  constructor() {
    super();

    /** @type {string|null} */
    this._roomId = null;

    /** @type {string|null} */
    this._localPeerId = null;

    /** @type {Function|null} Application message sink (ConnectionManager) */
    this._messageCallback = null;

    /** @type {Function|null} Outgoing SDP/ICE sink (ConnectionManager) */
    this._signalingCallback = null;

    /** @type {Function|null} Notified when channel connectivity changes */
    this._onChannelStateChangeCallback = null;

    /** @type {number} Open DataChannels, as last reported by the offscreen doc */
    this._openChannels = 0;

    /** @type {Promise<void>|null} In-flight offscreen document creation */
    this._creatingOffscreen = null;

    /**
     * The INIT payload the offscreen document needs before it can negotiate,
     * held until it has been acknowledged.
     *
     * Creating the document can fail transiently. If INIT were sent only from
     * connect(), a failure there would leave the document running without a
     * local peer ID, and it would compute its offerer/answerer role against
     * `null` — so both peers could end up answering and never connect.
     * Re-sending it from every call makes the transport self-healing.
     *
     * @type {object|null}
     */
    this._pendingInit = null;

    /** @type {{servers: RTCIceServer[], fetchedAt: number}|null} */
    this._iceCache = null;

    // Bound so it can be removed on disconnect.
    this._boundOffscreenListener = this._handleOffscreenMessage.bind(this);
    chrome.runtime.onMessage.addListener(this._boundOffscreenListener);
  }

  // ── Transport interface ───────────────────────────────────────

  /**
   * Prepare the offscreen document and hand it this session's identity.
   * Connections themselves are established when `syncPeers` names peers.
   *
   * @param {string} roomId
   * @param {string} peerId
   * @returns {Promise<void>}
   */
  async connect(roomId, peerId) {
    this._roomId = roomId;
    this._localPeerId = peerId;
    this._openChannels = 0;

    const iceServers = await this._getIceServers();
    this._pendingInit = { op: 'INIT', roomId, peerId, iceServers };

    try {
      // Send it now if we can; _callOffscreen will retry on any later op.
      await this._callOffscreen({ op: 'GET_STATE' });
      console.log(`[WebRTCTransport] Ready for room=${roomId}, peer=${peerId}`);
    } catch (err) {
      // Losing P2P does not lose the session: ConnectionManager keeps the
      // WebSocket relay as the active transport.
      console.error('[WebRTCTransport] Offscreen document unavailable:', err);
    }
  }

  /**
   * Broadcast a wire message to all connected peers.
   * @param {object} message
   */
  send(message) {
    this._callOffscreen({ op: 'SEND', message })
      .then((response) => {
        if (response && response.sent === 0) {
          console.warn('[WebRTCTransport] send() reached no open data channels');
        }
      })
      .catch((err) => {
        console.error('[WebRTCTransport] send() failed:', err);
      });
  }

  /** @param {Function} callback */
  onMessage(callback) {
    this._messageCallback = callback;
  }

  /**
   * True when at least one DataChannel is open. ConnectionManager decides
   * whether that is *enough* channels to carry the room.
   * @returns {boolean}
   */
  isConnected() {
    return this._openChannels > 0;
  }

  /** @returns {Promise<void>} */
  async disconnect() {
    console.log('[WebRTCTransport] Tearing down all peer connections');
    this._openChannels = 0;
    this._roomId = null;
    this._localPeerId = null;
    this._pendingInit = null;

    try {
      await this._callOffscreen({ op: 'TEARDOWN' });
      await this._closeOffscreenDocument();
    } catch (err) {
      console.debug('[WebRTCTransport] Teardown error (ignored):', err);
    }
  }

  // ── Signaling, driven by ConnectionManager ───────────────────

  /**
   * Register the sink for outgoing SDP/ICE messages. ConnectionManager routes
   * them over the WebSocket, which is always connected for exactly this reason.
   * @param {Function} callback
   */
  onSignaling(callback) {
    this._signalingCallback = callback;
  }

  /**
   * Register a callback for DataChannel connectivity changes, so the manager
   * can re-evaluate which transport should be active.
   * @param {Function} callback
   */
  onChannelStateChange(callback) {
    this._onChannelStateChangeCallback = callback;
  }

  /**
   * Reconcile connections against the room's authoritative peer list.
   *
   * Passing the whole list rather than add/remove deltas means a dropped JOIN,
   * a missed LEAVE, or a service-worker restart cannot leave the mesh
   * permanently inconsistent — the next ROOM_STATE repairs it.
   *
   * @param {string[]} peerIds - all peers in the room, including this one
   * @returns {Promise<void>}
   */
  async syncPeers(peerIds) {
    if (!this._roomId) return;
    try {
      const response = await this._callOffscreen({ op: 'SYNC_PEERS', peerIds });
      if (response && typeof response.openChannels === 'number') {
        this._updateOpenChannels(response.openChannels);
      }
    } catch (err) {
      console.debug('[WebRTCTransport] syncPeers failed:', err);
    }
  }

  /**
   * @param {string} peerId
   * @returns {Promise<void>}
   */
  async removePeer(peerId) {
    if (!peerId) return;
    try {
      await this._callOffscreen({ op: 'REMOVE_PEER', peerId });
    } catch (err) {
      console.debug('[WebRTCTransport] removePeer failed:', err);
    }
  }

  /**
   * @param {string} senderId
   * @param {RTCSessionDescriptionInit} sdp
   * @returns {Promise<void>}
   */
  async handleOffer(senderId, sdp) {
    await this._forwardSignaling({ op: 'HANDLE_OFFER', peerId: senderId, sdp });
  }

  /**
   * @param {string} senderId
   * @param {RTCSessionDescriptionInit} sdp
   * @returns {Promise<void>}
   */
  async handleAnswer(senderId, sdp) {
    await this._forwardSignaling({ op: 'HANDLE_ANSWER', peerId: senderId, sdp });
  }

  /**
   * @param {string} senderId
   * @param {RTCIceCandidateInit} candidate
   * @returns {Promise<void>}
   */
  async handleIceCandidate(senderId, candidate) {
    await this._forwardSignaling({ op: 'HANDLE_ICE', peerId: senderId, candidate });
  }

  // ── Diagnostics ───────────────────────────────────────────────

  /** @returns {number} */
  getOpenChannelCount() {
    return this._openChannels;
  }

  /**
   * Transport-level RTT per peer, straight from the succeeded ICE candidate
   * pair. More accurate than an application-level PING/PONG, which also
   * absorbs service-worker wake-up and message-passing overhead.
   *
   * @returns {Promise<{peerId: string, rttMs: number}[]>}
   */
  async getRttSamples() {
    try {
      const response = await this._callOffscreen({ op: 'GET_RTT' });
      return (response && response.samples) || [];
    } catch {
      return [];
    }
  }

  // ── Offscreen document plumbing ───────────────────────────────

  /**
   * Route a message from the offscreen document into the Transport interface.
   * @private
   */
  _handleOffscreenMessage(message, _sender, _sendResponse) {
    if (!message || message.target !== WORKER_TARGET) return false;

    switch (message.event) {
      case 'SIGNALING': {
        if (!this._signalingCallback) {
          console.warn('[WebRTCTransport] No signaling callback registered');
          break;
        }
        this._signalingCallback({
          type: message.signalType,
          roomId: this._roomId,
          senderId: this._localPeerId,
          // Structural messages sit outside the application Lamport ordering.
          lamportClock: 0,
          payload: {
            targetPeerId: message.targetPeerId,
            ...message.body,
          },
        });
        break;
      }

      case 'MESSAGE':
        if (this._messageCallback) this._messageCallback(message.message);
        break;

      case 'CHANNEL_STATE':
        this._updateOpenChannels(message.openChannels);
        break;

      default:
        break;
    }

    return false; // No response expected.
  }

  /**
   * @param {number} count
   * @private
   */
  _updateOpenChannels(count) {
    const previous = this._openChannels;
    this._openChannels = count;

    if (previous !== count && this._onChannelStateChangeCallback) {
      this._onChannelStateChangeCallback();
    }
  }

  /**
   * Send an op to the offscreen document, starting it first if needed.
   * @param {object} payload
   * @returns {Promise<object>}
   * @private
   */
  async _callOffscreen(payload) {
    await this._ensureOffscreenDocument();

    // Deliver the deferred INIT before anything that depends on it. Held until
    // it succeeds, so a transient failure cannot leave the document negotiating
    // without a local peer ID.
    if (this._pendingInit) {
      const init = this._pendingInit;
      await chrome.runtime.sendMessage({ target: OFFSCREEN_TARGET, ...init });
      this._pendingInit = null;
    }

    return chrome.runtime.sendMessage({ target: OFFSCREEN_TARGET, ...payload });
  }

  /**
   * Forward a signaling op, tolerating the case where no offscreen document
   * exists yet (a peer can offer before this side finished setting up).
   * @param {object} payload
   * @private
   */
  async _forwardSignaling(payload) {
    try {
      await this._callOffscreen(payload);
    } catch (err) {
      console.debug(`[WebRTCTransport] ${payload.op} failed:`, err);
    }
  }

  /**
   * Create the offscreen document if it is not already running.
   *
   * Chrome permits exactly one offscreen document per extension, and a second
   * createDocument call rejects. Concurrent callers therefore share a single
   * in-flight promise.
   *
   * @returns {Promise<void>}
   * @private
   */
  async _ensureOffscreenDocument() {
    if (await this._hasOffscreenDocument()) return;

    if (this._creatingOffscreen) {
      await this._creatingOffscreen;
      return;
    }

    this._creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['WEB_RTC'],
        justification:
          'Host RTCPeerConnection and RTCDataChannel for peer-to-peer playback ' +
          'sync; WebRTC is not available in an MV3 service worker.',
      })
      .catch((err) => {
        // A racing creation elsewhere already produced the document.
        if (String(err && err.message).includes('Only a single offscreen')) return;
        throw err;
      })
      .finally(() => {
        this._creatingOffscreen = null;
      });

    await this._creatingOffscreen;
  }

  /**
   * @returns {Promise<boolean>}
   * @private
   */
  async _hasOffscreenDocument() {
    try {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
      });
      return contexts.length > 0;
    } catch {
      // getContexts needs Chrome 116. Report absence and let createDocument's
      // "only a single offscreen document" rejection be the real guard.
      return false;
    }
  }

  /**
   * @returns {Promise<void>}
   * @private
   */
  async _closeOffscreenDocument() {
    if (!(await this._hasOffscreenDocument())) return;
    try {
      await chrome.offscreen.closeDocument();
    } catch (err) {
      console.debug('[WebRTCTransport] closeDocument failed:', err);
    }
  }

  // ── ICE server provisioning ───────────────────────────────────

  /**
   * Fetch STUN and (if the server has TURN configured) short-lived TURN
   * credentials.
   *
   * STUN alone only suffices when a direct path can form. Symmetric NAT and
   * carrier-grade NAT — most mobile networks — need a TURN relay, so without
   * one those peers silently never connect and the room falls back to the
   * WebSocket relay forever.
   *
   * @returns {Promise<RTCIceServer[]>}
   * @private
   */
  async _getIceServers() {
    if (this._iceCache && Date.now() - this._iceCache.fetchedAt < ICE_CACHE_TTL_MS) {
      return this._iceCache.servers;
    }

    const abort = new AbortController();
    const timeoutId = setTimeout(() => abort.abort(), ICE_FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(ICE_ENDPOINT, {
        cache: 'no-store',
        signal: abort.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const body = await response.json();
      if (!Array.isArray(body.iceServers) || body.iceServers.length === 0) {
        throw new Error('No iceServers in response');
      }

      this._iceCache = { servers: body.iceServers, fetchedAt: Date.now() };
      console.log(
        `[WebRTCTransport] Got ${body.iceServers.length} ICE servers ` +
        `(TURN ${body.turn ? 'available' : 'unavailable'})`
      );
      return body.iceServers;
    } catch (err) {
      const reason = err.name === 'AbortError'
        ? `no response in ${ICE_FETCH_TIMEOUT_MS}ms`
        : err.message;
      console.warn(`[WebRTCTransport] ICE fetch failed (${reason}); using STUN only`);
      return FALLBACK_ICE_SERVERS;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
