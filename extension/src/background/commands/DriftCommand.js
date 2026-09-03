/**
 * DriftCommand — Command Pattern Implementation
 *
 * A small, routine correction toward the host's position, issued when a
 * heartbeat shows this peer has drifted.
 *
 * Distinct from ROOM_STATE deliberately. ROOM_STATE means "you are somewhere
 * else entirely, get here now" and hard-seeks; that is right for a late joiner
 * but unwatchable if it fires every couple of seconds. DRIFT means "you are
 * slightly off", and the adapter absorbs it by nudging playback rate for a
 * moment so the correction is imperceptible. Only a drift too large to absorb
 * falls back to a seek.
 */

import { SyncCommand, CommandFactory } from './SyncCommand.js';

export class DriftCommand extends SyncCommand {
  /**
   * @param {import('../../content/adapters/VideoAdapter.js').VideoAdapter} adapter
   */
  execute(adapter) {
    if (!adapter || typeof adapter.syncTo !== 'function') return;

    if (typeof this.payload.videoTime !== 'number' || !Number.isFinite(this.payload.videoTime)) {
      return;
    }

    adapter.syncTo(this.payload.videoTime, { isPaused: this.payload.isPaused });
  }

  serialize() {
    return {
      videoId: this.payload.videoId,
      videoTime: this.payload.videoTime,
      isPaused: this.payload.isPaused,
    };
  }
}

CommandFactory.register('DRIFT', DriftCommand);
