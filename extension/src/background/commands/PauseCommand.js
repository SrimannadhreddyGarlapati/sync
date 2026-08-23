/**
 * PauseCommand — Command Pattern Implementation
 * 
 * Pauses video playback on the receiving peer's VideoAdapter.
 */

import { SyncCommand, CommandFactory } from './SyncCommand.js';

export class PauseCommand extends SyncCommand {
  /**
   * @param {object} payload
   * @param {number} [payload.videoTime] - Time at which pause was triggered
   * @param {string} [payload.videoId] - YouTube video ID for validation
   */
  constructor(payload = {}) {
    super(payload);
  }

  /**
   * @param {import('../../content/adapters/VideoAdapter.js').VideoAdapter} adapter
   */
  execute(adapter) {
    adapter.pause();
    if (Number.isFinite(this.payload.videoTime)) {
      adapter.seek(this.payload.videoTime);
    }
  }

  serialize() {
    return {
      videoTime: this.payload.videoTime,
      videoId: this.payload.videoId,
    };
  }
}

// Self-register with the factory
CommandFactory.register('PAUSE', PauseCommand);