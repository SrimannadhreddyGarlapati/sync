/**
 * PlayCommand — Command Pattern Implementation
 * 
 * Resumes video playback on the receiving peer's VideoAdapter.
 */

import { SyncCommand, CommandFactory } from './SyncCommand.js';

export class PlayCommand extends SyncCommand {
  /**
   * @param {object} payload
   * @param {number} [payload.videoTime] - Time at which play was triggered
   */
  constructor(payload = {}) {
    super(payload);
  }

  /**
   * @param {import('../../content/adapters/VideoAdapter.js').VideoAdapter} adapter
   */
  execute(adapter) {
    if (!adapter || typeof adapter.play !== 'function') {
      console.warn('[SyncTube] PlayCommand: Invalid adapter provided');
      return;
    }

    if (typeof this.payload.videoTime === 'number' && Number.isFinite(this.payload.videoTime)) {
      adapter.seek(this.payload.videoTime);
    }
    
    adapter.play();
  }

  serialize() {
    const data = { videoId: this.payload.videoId };
    
    if (typeof this.payload.videoTime === 'number' && Number.isFinite(this.payload.videoTime)) {
      data.videoTime = this.payload.videoTime;
    }
    
    return data;
  }
}

// Self-register with the factory
CommandFactory.register('PLAY', PlayCommand);