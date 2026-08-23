/**
 * RequestStateCommand — Command Pattern Implementation
 * 
 * Sent by a newly joined peer to ask the host for the current room
 * state (videoId, videoTime, isPaused). This command is never executed
 * against a VideoAdapter — it is intercepted by SyncEngine's
 * 'command:received' handler, which queries the host's content script
 * and replies with a ROOM_STATE broadcast.
 * 
 * This class exists so that REQUEST_STATE messages pass through the
 * same CommandFactory deserialization pipeline as all other commands,
 * maintaining a uniform wire protocol.
 */

import { SyncCommand, CommandFactory } from './SyncCommand.js';

export class RequestStateCommand extends SyncCommand {
  /**
   * No-op. Intercepted by SyncEngine before reaching any adapter.
   * @param {import('../../content/adapters/VideoAdapter.js').VideoAdapter} _adapter
   */
  execute(_adapter) {
    console.warn('[SyncTube] Architectural Leak: RequestStateCommand reached adapter. This command should have been intercepted by the SyncEngine.');
  }

  serialize() {
    return {};
  }
}

CommandFactory.register('REQUEST_STATE', RequestStateCommand);