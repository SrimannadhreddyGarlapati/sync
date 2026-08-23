/**
 * VideoAdapter — Adapter Pattern (Abstract Base)
 * 
 * Defines a platform-agnostic interface for controlling video playback.
 * Concrete implementations (YouTubeAdapter, future NetflixAdapter, etc.)
 * interact with the platform's specific <video> element and DOM events.
 * 
 * OOP Pillar: Adapter pattern — SyncEngine talks to a uniform interface;
 * platform-specific quirks are isolated in subclasses.
 */

// Namespace to avoid polluting the page's globals
window.SyncTube = window.SyncTube || {};

window.SyncTube.VideoAdapter = class VideoAdapter {
  constructor() {
    if (new.target === window.SyncTube.VideoAdapter) {
      throw new TypeError("Cannot construct Abstract instances of VideoAdapter directly.");
    }

    // Initialize callbacks as no-ops to prevent null reference errors
    // if a DOM event fires before the content script registers its callbacks.
    this._onPlayCallback = () => {};
    this._onPauseCallback = () => {};
    this._onSeekCallback = () => {};
    this._onVideoChangeCallback = () => {};
    this._onInterruptionStartCallback = () => {};
    this._onInterruptionEndCallback = () => {};
  }

  /* =====================================================================
   * PLAYBACK CONTROLS (Must be overridden by subclasses)
   * ===================================================================== */

  /**
   * Start video playback.
   */
  play() {
    throw new Error('VideoAdapter: method play() must be implemented by subclass.');
  }

  /**
   * Pause video playback.
   */
  pause() {
    throw new Error('VideoAdapter: method pause() must be implemented by subclass.');
  }

  /**
   * Seek to a specific time.
   * @param {number} time - Target time in seconds
   */
  seek(time) {
    throw new Error('VideoAdapter: method seek() must be implemented by subclass.');
  }

  /* =====================================================================
   * STATE GETTERS (Must be overridden by subclasses)
   * ===================================================================== */

  /**
   * Get the current playback time.
   * @returns {number} Current time in seconds
   */
  getCurrentTime() {
    throw new Error('VideoAdapter: method getCurrentTime() must be implemented by subclass.');
  }

  /**
   * Get total video duration.
   * @returns {number} Duration in seconds
   */
  getDuration() {
    throw new Error('VideoAdapter: method getDuration() must be implemented by subclass.');
  }

  /**
   * Check if the video is currently paused.
   * @returns {boolean}
   */
  isPaused() {
    throw new Error('VideoAdapter: method isPaused() must be implemented by subclass.');
  }

  /**
   * Get the current video ID (platform-specific identifier).
   * @returns {string|null}
   */
  getVideoId() {
    throw new Error('VideoAdapter: method getVideoId() must be implemented by subclass.');
  }

  /**
   * Check if the video element is ready for playback commands.
   * @returns {boolean}
   */
  isReady() {
    throw new Error('VideoAdapter: method isReady() must be implemented by subclass.');
  }

  /* =====================================================================
   * EVENT REGISTRATION (Implemented in Base Class)
   * ===================================================================== */

  /**
   * Register a callback for when the user plays the video.
   * @param {Function} callback
   */
  onUserPlay(callback) {
    this._onPlayCallback = callback;
  }

  /**
   * Register a callback for when the user pauses the video.
   * @param {Function} callback
   */
  onUserPause(callback) {
    this._onPauseCallback = callback;
  }

  /**
   * Register a callback for when the user seeks the video.
   * @param {Function} callback - Called with (newTime: number)
   */
  onUserSeek(callback) {
    this._onSeekCallback = callback;
  }

  /**
   * Register a callback for when the video ID changes (user navigated to
   * a different video on the same platform without reloading).
   * @param {Function} callback - Called with (newVideoId: string)
   */
  onVideoChange(callback) {
    this._onVideoChangeCallback = callback;
  }

  /**
   * Register a callback for when an interruption starts (e.g. buffering, ad).
   * @param {Function} callback - Called with (videoId, videoTime)
   */
  onInterruptionStart(callback) {
    this._onInterruptionStartCallback = callback;
  }

  /**
   * Register a callback for when an interruption ends.
   * @param {Function} callback - Called with (videoId, videoTime)
   */
  onInterruptionEnd(callback) {
    this._onInterruptionEndCallback = callback;
  }

  /* =====================================================================
   * REMOTE COMMAND EXECUTION
   * ===================================================================== */

  /**
   * Apply a remote command with echo suppression.
   * @param {object} command - A ClientCommand instance (e.g., ClientPlayCommand)
   */
  applyRemoteCommand(command) {
    if (command && typeof command.execute === 'function') {
      command.execute(this);
    } else {
      throw new Error('VideoAdapter: Invalid command passed to applyRemoteCommand.');
    }
  }

  /* =====================================================================
   * LIFECYCLE
   * ===================================================================== */

  /**
   * Clean up all event listeners, observers, and references.
   * Subclasses MUST override this to remove their specific DOM listeners.
   */
  destroy() {
    this._onPlayCallback = () => {};
    this._onPauseCallback = () => {};
    this._onSeekCallback = () => {};
    this._onVideoChangeCallback = () => {};
    this._onInterruptionStartCallback = () => {};
    this._onInterruptionEndCallback = () => {};
  }
};