/**
 * SyncCommand — Command Pattern (Abstract Base)
 * 
 * Encapsulates playback actions as first-class objects. Each command
 * can be serialized for wire transmission and executed against a
 * VideoAdapter on the receiving end.
 * 
 * OOP Pillar: Command pattern — decouples the object that invokes an
 * action from the object that performs it. Enables:
 *   - Uniform serialization/deserialization of all playback actions
 *   - Future undo/redo capability
 *   - Command logging and replay
 */
export class SyncCommand {
  /**
   * @param {object} [payload={}] - Wire protocol payload
   */
  constructor(payload = {}) {
    /** @type {object} */
    this.payload = payload;
  }

  /**
   * Execute this command against a VideoAdapter.
   * @param {import('../../content/adapters/VideoAdapter.js').VideoAdapter} adapter
   * @throws {Error} If called on the abstract base class
   */
  execute(adapter) {
    // Improved error message to identify which subclass forgot to implement execute()
    throw new Error(`${this.constructor.name}.execute() not implemented`);
  }

  /**
   * Serialize this command into the wire protocol payload shape.
   * @returns {object} Payload suitable for the "payload" field of a wire message
   */
  serialize() {
    // Shallow copy prevents accidental mutation of the internal payload state
    return { ...this.payload };
  }
}

/**
 * CommandFactory — Deserializes incoming wire messages into concrete
 * SyncCommand instances.
 */
export class CommandFactory {
  /**
   * @type {Map<string, typeof SyncCommand>}
   * @private
   */
  static _registry = new Map();

  /**
   * Register a command class for a wire message type.
   * @param {string} type - Wire protocol message type (e.g., 'PLAY')
   * @param {typeof SyncCommand} CommandClass - The concrete command class
   * @throws {Error} If registration parameters are invalid
   */
  static register(type, CommandClass) {
    if (!type || !CommandClass) {
      throw new Error('[CommandFactory] .register() requires both a type and a CommandClass.');
    }
    CommandFactory._registry.set(type, CommandClass);
  }

  /**
   * Create a command from an incoming wire message.
   * @param {object} wireMessage - Full wire protocol message
   * @returns {SyncCommand|null} The deserialized command, or null if invalid/unknown
   */
  static fromWireMessage(wireMessage) {
    // Defensive check: prevent TypeError if wireMessage is null or undefined
    if (!wireMessage || typeof wireMessage.type !== 'string') {
      console.warn('[CommandFactory] Invalid wire message format received:', wireMessage);
      return null;
    }

    const CommandClass = CommandFactory._registry.get(wireMessage.type);
    if (!CommandClass) {
      console.warn(`[CommandFactory] Unknown command type: "${wireMessage.type}"`);
      return null;
    }

    // Default to empty object if payload is missing to prevent downstream destructuring errors
    return new CommandClass(wireMessage.payload || {});
  }
}