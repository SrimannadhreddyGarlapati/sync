/**
 * SeekCommand — Command Pattern Implementation
 * 
 * Seeks the video to a specific timestamp on the receiving peer.
 */

import { SyncCommand, CommandFactory } from './SyncCommand.js';

export class SeekCommand extends SyncCommand {
  /**
   * @param {object} payload
   * @param {number|string} payload.videoTime - Target time in seconds
   * @param {string} [payload.videoId] - Optional video ID for verification
   */
  constructor(payload = {}) {
    super(payload);
    
    // Ensure videoTime is a valid float. Network payloads might arrive as strings or undefined.
    const parsedTime = parseFloat(payload.videoTime);
    this.payload.videoTime = !isNaN(parsedTime) ? parsedTime : 0;

    // Ensure videoId is properly passed through if it exists
    this.payload.videoId = typeof payload.videoId === 'string' ? payload.videoId : null;
  }

  /**
   * @param {import('../../content/adapters/VideoAdapter.js').VideoAdapter} adapter
   */
  execute(adapter) {
    // Guard clause: Protects against execution during SPA navigation/teardowns
    if (!adapter || typeof adapter.seek !== 'function') {
      console.warn('[SeekCommand] Cannot execute: Invalid or missing video adapter.');
      return;
    }

    // Ensure we never seek to a negative time
    const targetTime = Math.max(0, this.payload.videoTime);
    adapter.seek(targetTime);
  }

  serialize() {
    const serialized = {
      videoTime: this.payload.videoTime,
    };
    
    // Only include videoId if it's present to save bytes on the wire
    if (this.payload.videoId) {
      serialized.videoId = this.payload.videoId;
    }
    
    return serialized;
  }
}

// Self-register with the factory
CommandFactory.register('SEEK', SeekCommand);