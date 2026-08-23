/**
 * ForceSyncCommand — Command Pattern Implementation
 * 
 * User-initiated full state reconciliation. Seeks to the host's
 * current position and resumes playback, overriding any local state.
 * 
 * Triggered by the "Force Sync" button in the popup or the
 * "Check if I'm Synced" feature.
 */

import { SyncCommand, CommandFactory } from './SyncCommand.js';

export class ForceSyncCommand extends SyncCommand {
  /**
   * @param {object} payload
   * @param {number} payload.videoTime - Host's current playback time
   * @param {string} [payload.videoId] - Host's current video ID (for video mismatch detection)
   */
  constructor(payload = {}) {
    super(payload);
  }

  /**
   * Executes the force sync on the provided video adapter.
   * 
   * @param {import('../../content/adapters/VideoAdapter.js').VideoAdapter} adapter
   */
  execute(adapter) {
    // Safety check: Validate that videoTime is a valid number before seeking. 
    // This protects the adapter from throwing errors if malformed data comes over the wire.
    if (typeof this.payload.videoTime === 'number' && !isNaN(this.payload.videoTime)) {
      adapter.seek(this.payload.videoTime);
    }
    
    adapter.play();
  }

  /**
   * Serializes the command payload for the wire protocol.
   * 
   * @returns {{videoTime: number, videoId: string|undefined}}
   */
  serialize() {
    return {
      videoTime: this.payload.videoTime,
      videoId: this.payload.videoId,
    };
  }
}

// Self-register with the factory
CommandFactory.register('FORCE_SYNC', ForceSyncCommand);