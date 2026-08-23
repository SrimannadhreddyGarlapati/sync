/**
 * RoomStateCommand — Command Pattern Implementation
 * 
 * Represents a full room state snapshot for late-joiner sync.
 * Carries videoId, videoTime, and isPaused so the joining peer
 * can synchronize to the room's current playback position.
 * 
 * Note: Video-switching (URL redirect) is NOT handled here because
 * commands execute against the VideoAdapter interface, which has no
 * concept of navigation. The content script's APPLY_COMMAND handler
 * checks for videoId mismatches and performs the redirect at the
 * application layer before invoking applyRemoteCommand().
 */

import { SyncCommand, CommandFactory } from './SyncCommand.js';

export class RoomStateCommand extends SyncCommand {
  /**
   * Synchronize the adapter to the room's playback state.
   * Only handles time and play/pause — video switching is the
   * responsibility of the content script layer.
   * 
   * @param {import('../../content/adapters/VideoAdapter.js').VideoAdapter} adapter
   */
  execute(adapter) {
    if (typeof this.payload.videoTime === 'number' && Number.isFinite(this.payload.videoTime)) {
      adapter.seek(this.payload.videoTime);
    }
    
    if (typeof this.payload.isPaused === 'boolean') {
      this.payload.isPaused ? adapter.pause() : adapter.play();
    }
  }

  serialize() {
    return {
      videoId: this.payload.videoId,
      videoTime: this.payload.videoTime,
      isPaused: this.payload.isPaused,
    };
  }
}

CommandFactory.register('ROOM_STATE', RoomStateCommand);