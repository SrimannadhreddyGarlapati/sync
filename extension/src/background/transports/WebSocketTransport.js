/**
 * WebSocketTransport — Strategy Implementation
 * 
 * Handles sync-message relay through the FastAPI WebSocket server.
 * Used for:
 *   1. Signaling (always) — SDP offers/answers, ICE candidates
 *   2. Sync relay (fallback) — when WebRTC fails or room exceeds 5 users
 * 
 * Networks Pillar: Demonstrates reliable, ordered, full-duplex communication
 * over a single TCP connection (WebSocket protocol RFC 6455).
 * 
 * Reconnection: Uses exponential backoff (1s → 2s → 4s → ... → 30s cap)
 * with jitter to automatically re-establish dropped connections without 
 * overwhelming the server (Thundering Herd prevention).
 */

import { Transport } from './Transport.js';

/** @type {number} Initial reconnect delay in ms */
const RECONNECT_BASE_MS = 1000;

/** @type {number} Maximum reconnect delay in ms */
const RECONNECT_MAX_MS = 30000;

/** @type {number} Maximum number of reconnect attempts before giving up */
const RECONNECT_MAX_ATTEMPTS = 10;

export class WebSocketTransport extends Transport {
  constructor() {
    super();
    /** @type {WebSocket|null} */
    this._ws = null;

    /** @type {Function|null} */
    this._messageCallback = null;

    /** @type {Function|null} Callback when connection drops unexpectedly */
    this._onCloseCallback = null;

    /** @type {boolean} */
    this._connected = false;

    // ── Reconnection State ──────────────────────────────
    /** @type {string|null} Stored for reconnection */
    this._roomId = null;

    /** @type {string|null} Stored for reconnection */
    this._peerId = null;

    /** @type {boolean} True when disconnect() is called explicitly */
    this._intentionalClose = false;

    /** @type {number} Current reconnect attempt count */
    this._reconnectAttempts = 0;

    /** @type {number|null} Timer ID for pending reconnect */
    this._reconnectTimerId = null;
  }

  /**
   * @param {string} roomId
   * @param {string} peerId
   * @returns {Promise<void>}
   */
  async connect(roomId, peerId) {
    // Guard against multiple connect calls leaving orphaned sockets
    if (this._ws || this._reconnectTimerId) {
      await this.disconnect();
    }

    this._roomId = roomId;
    this._peerId = peerId;
    this._intentionalClose = false;
    this._reconnectAttempts = 0;

    return this._doConnect();
  }

  /**
   * Internal connect logic, reused by reconnection.
   * @returns {Promise<void>}
   * @private
   */
  _doConnect() {
    return new Promise((resolve, reject) => {
      const url = `wss://sync-l5pk.onrender.com/ws/${this._roomId}/${this._peerId}`;
      console.log(`[WebSocketTransport] Connecting to ${url}...`);
      
      let isResolved = false;

      try {
        this._ws = new WebSocket(url);
      } catch (err) {
        return reject(err);
      }

      this._ws.onopen = () => {
        console.log('[WebSocketTransport] Connected.');
        isResolved = true;
        this._connected = true;
        this._reconnectAttempts = 0; // Reset on successful connect
        resolve();
      };

      this._ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (this._messageCallback) {
            this._messageCallback(message);
          }
        } catch (err) {
          console.error('[WebSocketTransport] Error parsing incoming message:', err);
        }
      };

      this._ws.onerror = (error) => {
        console.error('[WebSocketTransport] WebSocket Error:', error);
        // If we haven't resolved the connection promise yet, reject it.
        if (!isResolved) {
          isResolved = true;
          reject(new Error('WebSocket connection failed'));
        }
      };

      this._ws.onclose = (event) => {
        const wasConnected = this._connected;
        this._connected = false;
        this._ws = null;

        // Catch edge case where onclose fires before onopen/onerror
        if (!isResolved) {
          isResolved = true;
          reject(new Error(`WebSocket closed before connecting: ${event.code}`));
        }

        if (this._intentionalClose) {
          console.log('[WebSocketTransport] Disconnected (intentional).');
          return;
        }

        console.warn(`[WebSocketTransport] Connection dropped unexpectedly (Code: ${event.code}).`);

        // Notify ConnectionManager so it can update state
        if (wasConnected && this._onCloseCallback) {
          this._onCloseCallback();
        }

        // Attempt reconnection with exponential backoff
        this._scheduleReconnect();
      };
    });
  }

  /**
   * Schedule a reconnection attempt with exponential backoff and jitter.
   * @private
   */
  _scheduleReconnect() {
    if (this._intentionalClose) return;
    if (this._reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      console.error(`[WebSocketTransport] Max reconnect attempts (${RECONNECT_MAX_ATTEMPTS}) reached. Giving up.`);
      return;
    }

    // Exponential backoff with jitter to prevent Thundering Herd
    const exponentialDelay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this._reconnectAttempts),
      RECONNECT_MAX_MS
    );
    const jitter = Math.random() * 200; // up to 200ms jitter
    const delay = Math.floor(exponentialDelay + jitter);
    
    this._reconnectAttempts++;

    console.log(`[WebSocketTransport] Reconnecting in ${delay}ms (attempt ${this._reconnectAttempts}/${RECONNECT_MAX_ATTEMPTS})...`);

    this._reconnectTimerId = setTimeout(async () => {
      this._reconnectTimerId = null;
      if (this._intentionalClose) return;

      try {
        await this._doConnect();
        console.log('[WebSocketTransport] Reconnected successfully.');
      } catch (err) {
        console.warn('[WebSocketTransport] Reconnect attempt failed:', err.message);
        // The onclose handler will automatically schedule the next attempt
      }
    }, delay);
  }

  /**
   * Register a callback for unexpected connection close.
   * Used by ConnectionManager to trigger RECONNECTING state.
   * @param {Function} callback
   */
  onClose(callback) {
    this._onCloseCallback = callback;
  }

  /**
   * @param {object} message
   */
  send(message) {
    // Strictly verify the socket is completely open before sending
    if (this._connected && this._ws && this._ws.readyState === WebSocket.OPEN) {
      try {
        this._ws.send(JSON.stringify(message));
      } catch (err) {
        console.error('[WebSocketTransport] Error stringifying/sending message:', err);
      }
    } else {
      console.warn('[WebSocketTransport] Cannot send message, socket not connected or not OPEN:', message);
    }
  }

  /**
   * @param {Function} callback
   */
  onMessage(callback) {
    this._messageCallback = callback;
  }

  /**
   * @returns {boolean}
   */
  isConnected() {
    return this._connected;
  }

  /**
   * Gracefully disconnect. Prevents reconnection.
   * @returns {Promise<void>}
   */
  async disconnect() {
    this._intentionalClose = true;

    // Cancel any pending reconnect timer
    if (this._reconnectTimerId !== null) {
      clearTimeout(this._reconnectTimerId);
      this._reconnectTimerId = null;
    }

    if (this._ws) {
      // 1000 indicates a normal, intentional closure
      if (this._ws.readyState === WebSocket.OPEN || this._ws.readyState === WebSocket.CONNECTING) {
        this._ws.close(1000, "Intentional disconnect");
      }
      this._ws = null;
    }
    
    this._connected = false;
    this._roomId = null;
    this._peerId = null;
    this._reconnectAttempts = 0;
  }
}
