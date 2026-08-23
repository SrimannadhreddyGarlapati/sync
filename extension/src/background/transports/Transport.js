/**
 * Transport — Strategy Pattern (Abstract Base)
 * 
 * Defines the interface for all sync transports. ConnectionManager
 * swaps between WebRTCTransport and WebSocketTransport at runtime
 * based on room size and NAT traversal success.
 * 
 * OOP Pillar: Strategy pattern — the transport algorithm is encapsulated
 * in interchangeable classes behind a common interface.
 * 
 * Networks Pillar: Abstracts the difference between WebSocket (reliable,
 * server-relayed) and WebRTC DataChannel (P2P, lower latency).
 * 
 * @abstract
 */
export class Transport {
  constructor() {
    if (this.constructor === Transport) {
      throw new Error("Abstract class 'Transport' cannot be instantiated directly.");
    }
  }

  /**
   * Establish a connection for the given room.
   * @abstract
   * @param {string} roomId
   * @param {string} peerId
   * @returns {Promise<void>}
   */
  async connect(roomId, peerId) {
    throw new Error('Transport.connect() must be implemented by subclass.');
  }

  /**
   * Send a message (wire-protocol envelope) to the room.
   * @abstract
   * @param {object} message - JSON-serializable wire protocol message
   */
  send(message) {
    throw new Error('Transport.send() must be implemented by subclass.');
  }

  /**
   * Register a callback for incoming messages.
   * @abstract
   * @param {Function} callback - Called with the parsed message object
   */
  onMessage(callback) {
    throw new Error('Transport.onMessage() must be implemented by subclass.');
  }

  /**
   * Check whether this transport is currently connected.
   * @abstract
   * @returns {boolean}
   */
  isConnected() {
    throw new Error('Transport.isConnected() must be implemented by subclass.');
  }

  /**
   * Gracefully disconnect.
   * @abstract
   * @returns {Promise<void>}
   */
  async disconnect() {
    throw new Error('Transport.disconnect() must be implemented by subclass.');
  }
}