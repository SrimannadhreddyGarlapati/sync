/**
 * EventBus — Observer Pattern
 * 
 * Decoupled publish/subscribe event system used for communication between
 * SyncEngine, ConnectionManager, SyncStateMachine, and the UI layer.
 * 
 * OS Analogy: This mirrors an IPC message bus — components communicate
 * without direct references, similar to how OS processes use message queues.
 * 
 * @example
 *   const bus = new EventBus();
 *   bus.on('state:changed', (newState) => console.log(newState));
 *   bus.emit('state:changed', 'SYNCED');
 */
export class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();
  }

  /**
   * Subscribe to an event.
   * @param {string} event - Event name
   * @param {Function} callback - Handler function
   * @returns {Function} Unsubscribe function for convenience
   */
  on(event, callback) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(callback);

    // Return an unsubscribe thunk
    return () => this.off(event, callback);
  }

  /**
   * Unsubscribe from an event.
   * @param {string} event - Event name
   * @param {Function} callback - The exact handler to remove
   */
  off(event, callback) {
    const handlers = this._listeners.get(event);
    if (handlers) {
      // Iterate to allow removing both direct callbacks and wrapped 'once' callbacks
      for (const handler of handlers) {
        if (handler === callback || handler.original === callback) {
          handlers.delete(handler);
          break; // Set guarantees uniqueness, so we can stop after finding it
        }
      }
      
      if (handlers.size === 0) {
        this._listeners.delete(event);
      }
    }
  }

  /**
   * Emit an event to all subscribers.
   * @param {string} event - Event name
   * @param {...*} args - Arguments passed to each handler
   */
  emit(event, ...args) {
    const handlers = this._listeners.get(event);
    if (handlers) {
      // Create a snapshot of handlers to prevent issues if a handler 
      // adds/removes listeners during the emission iteration cycle.
      const handlersSnapshot = Array.from(handlers);
      
      for (const handler of handlersSnapshot) {
        try {
          handler(...args);
        } catch (err) {
          // Catch and log to prevent one faulty handler from breaking the rest of the broadcast
          console.error(`[EventBus] Error in handler for "${event}":`, err);
        }
      }
    }
  }

  /**
   * Subscribe to an event for a single invocation, then auto-unsubscribe.
   * @param {string} event - Event name
   * @param {Function} callback - Handler function (called once)
   * @returns {Function} Unsubscribe function (can cancel before it fires)
   */
  once(event, callback) {
    const wrapper = (...args) => {
      this.off(event, wrapper);
      callback(...args);
    };
    
    // Attach original callback to the wrapper so off() can identify and remove it
    // if the caller decides to unsubscribe manually before it fires.
    wrapper.original = callback;
    
    return this.on(event, wrapper);
  }

  /**
   * Remove all listeners, optionally for a specific event.
   * @param {string} [event] - If provided, clears only that event's listeners
   */
  clear(event) {
    if (event) {
      this._listeners.delete(event);
    } else {
      this._listeners.clear();
    }
  }
}