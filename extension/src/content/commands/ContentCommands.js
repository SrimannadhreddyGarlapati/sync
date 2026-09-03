/**
 * ContentCommands — Client-Side Command Pattern
 * 
 * Replicates the Command Pattern from the background script,
 * allowing the content script to execute structured commands
 * received over IPC.
 */

(() => {
  window.SyncTube = window.SyncTube || {};

  class ClientSyncCommand {
    constructor(payload) {
      this.payload = payload || {};
    }

    execute(adapter) {
      throw new Error('execute() not implemented');
    }
  }

  class ClientPlayCommand extends ClientSyncCommand {
    execute(adapter) {
      if (!adapter) return;
      if (this.payload.videoTime !== undefined) {
        adapter.seek(this.payload.videoTime);
      }
      adapter.play();
    }
  }

  class ClientPauseCommand extends ClientSyncCommand {
    execute(adapter) {
      if (!adapter) return;
      adapter.pause();
      if (this.payload.videoTime !== undefined) {
        adapter.seek(this.payload.videoTime);
      }
    }
  }

  class ClientSeekCommand extends ClientSyncCommand {
    execute(adapter) {
      if (!adapter) return;
      if (this.payload.videoTime !== undefined) {
        adapter.seek(this.payload.videoTime);
      }
    }
  }

  class ClientForceSyncCommand extends ClientSyncCommand {
    execute(adapter) {
      if (!adapter) return;
      if (this.payload.videoTime !== undefined) {
        adapter.seek(this.payload.videoTime);
      }
      adapter.play();
    }
  }

  class ClientRoomStateCommand extends ClientSyncCommand {
    execute(adapter) {
      // 1. Check if the video ID matches. If not, trigger SPA navigation.
      const currentVideoId = adapter ? adapter.getVideoId() : null;
      
      if (this.payload.videoId && currentVideoId !== this.payload.videoId) {
        console.log(`[SyncTube] Switching video from ${currentVideoId} to ${this.payload.videoId}`);
        
        // Use YouTube's internal SPA router by simulating a link click.
        // This prevents a hard reload, keeping the content script active and fast.
        const time = Math.floor(this.payload.videoTime || 0);
        const a = document.createElement('a');
        a.href = `/watch?v=${this.payload.videoId}&t=${time}s`;
        a.style.display = 'none';
        document.body.appendChild(a);
        
        a.click();
        a.remove();
        
        // Do not apply play/pause state yet. The adapter will re-initialize on yt-navigate-finish.
        return; 
      }

      if (!adapter) return;

      // 2. Video matches. Apply playback state.
      if (this.payload.videoTime !== undefined) {
        adapter.seek(this.payload.videoTime);
      }
      
      if (this.payload.isPaused === true) {
        adapter.pause();
      } else if (this.payload.isPaused === false) {
        adapter.play();
      }
    }
  }

  /**
   * A routine correction toward the host's position.
   *
   * Delegates to adapter.syncTo, which absorbs a small error by briefly
   * altering playback rate rather than seeking. That distinction is the whole
   * point of having a separate command from ROOM_STATE: corrections arrive
   * every couple of seconds, and a visible seek that often is unwatchable.
   */
  class ClientDriftCommand extends ClientSyncCommand {
    execute(adapter) {
      if (!adapter || typeof adapter.syncTo !== 'function') return;
      if (typeof this.payload.videoTime !== 'number') return;

      adapter.syncTo(this.payload.videoTime, { isPaused: this.payload.isPaused });
    }
  }

  window.SyncTube.ClientCommandFactory = class ClientCommandFactory {
    static _registry = new Map([
      ['PLAY', ClientPlayCommand],
      ['PAUSE', ClientPauseCommand],
      ['SEEK', ClientSeekCommand],
      ['FORCE_SYNC', ClientForceSyncCommand],
      ['ROOM_STATE', ClientRoomStateCommand],
      ['DRIFT', ClientDriftCommand]
    ]);

    static fromWireMessage(message) {
      if (!message || !message.type) return null;

      // Ensure robust extraction. The background wire protocol uses 'payload', 
      // but IPC wrappers sometimes nest it as 'command'.
      const type = message.type;
      const payload = message.payload || message.command || {};
      
      const CommandClass = this._registry.get(type);
      if (!CommandClass) {
        console.warn(`[SyncTube] Unknown command type: "${type}"`);
        return null;
      }
      
      return new CommandClass(payload);
    }
  };

})();