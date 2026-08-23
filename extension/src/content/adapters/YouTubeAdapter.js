/**
 * YouTubeAdapter — Adapter Pattern Implementation
 * 
 * Wraps YouTube's <video> element and DOM events to provide a
 * platform-specific implementation of VideoAdapter.
 * 
 * YouTube-Specific Challenges Handled:
 * 
 *   1. SPA Navigation — YouTube doesn't do full page reloads. The <video>
 *      element persists across navigations but its source changes. We monitor
 *      for video ID changes via URL polling and the `yt-navigate-finish` event.
 * 
 *   2. Ad Detection — Ads play on the same <video> element. During ads,
 *      sync commands must be suppressed to avoid fighting the ad player.
 *      We detect ads via YouTube's DOM class `.ad-showing` on the player.
 * 
 *   3. Seek Event Coalescing — A single user seek can fire multiple
 *      `seeking` events in rapid succession (e.g., scrubbing the timeline).
 *      We debounce seeks using a short window so only the final position
 *      is broadcast to peers.
 * 
 *   4. Echo Suppression (§7) — Programmatic calls to play/pause/seek fire
 *      the same DOM events as user actions. We use a timestamp window
 *      (not a boolean) to suppress echoes, which auto-recovers even if
 *      events are dropped or delayed by the browser.
 * 
 *   5. Buffering — YouTube may pause internally while buffering. We
 *      distinguish buffering pauses from user pauses using readyState
 *      and the `waiting`/`playing` events.
 */

window.SyncTube = window.SyncTube || {};

window.SyncTube.YouTubeAdapter = class YouTubeAdapter extends window.SyncTube.VideoAdapter {
  constructor() {
    super();

    /** @type {HTMLVideoElement|null} */
    this._video = null;

    /**
     * Echo Suppression (§7) — State Flag + State Check Pattern.
     *
     * Two-layer defense against infinite echo loops:
     *
     * Layer 1 — State Checks (primary):
     *   play() skips if !video.paused (already playing).
     *   pause() skips if video.paused (already paused).
     *   If state already matches, no DOM call, no event, no echo.
     *
     * Layer 2 — Consumed Flags (secondary):
     *   play()/pause() set _remotePlayPending/_remotePausePending = true
     *   before the DOM call. The corresponding event handler checks
     *   and consumes the flag, regardless of when the event fires.
     *
     * @type {number} 2s window prevents Joiners from broadcasting PLAY(t=0) on load.
     */
    this._suppressUntil = Date.now() + 2000;

    /** @type {boolean} Set before programmatic play(), consumed by play event */
    this._remotePlayPending = false;

    /** @type {boolean} Set before programmatic pause(), consumed by pause event */
    this._remotePausePending = false;

    // ── User action callbacks ─────────────────────────────────
    /** @type {Function|null} */
    this._onPlayCallback = null;
    /** @type {Function|null} */
    this._onPauseCallback = null;
    /** @type {Function|null} */
    this._onSeekCallback = null;
    /** @type {Function|null} */
    this._onVideoChangeCallback = null;
    /** @type {Function|null} */
    this._onInterruptionStartCallback = null;
    /** @type {Function|null} */
    this._onInterruptionEndCallback = null;

    // ── Seek debouncing ───────────────────────────────────────
    /** @type {number|null} Timer ID for seek debounce */
    this._seekDebounceTimer = null;
    /** @type {number} Debounce delay for seek coalescing (ms) */
    this._seekDebounceMs = 250;
    /** @type {number} Last known time before a seek started */
    this._preSeekTime = 0;
    /** @type {boolean} Whether a seek operation is in progress */
    this._isSeeking = false;
    /** @type {boolean} Whether the current seek was programmatically initiated */
    this._isProgrammaticSeek = false;

    // ── Video ID & Interruption tracking ──────────────────────
    /** @type {string|null} Currently tracked video ID */
    this._currentVideoId = null;
    /** @type {number|null} Video ID poll interval */
    this._videoIdPollInterval = null;
    /** @type {boolean} Whether the video is currently buffering */
    this._isBuffering = false;
    /** @type {boolean} Whether an ad is currently playing */
    this._isAdActive = false;
    /** @type {boolean} Combined interruption state */
    this._isInterrupted = false;
    /** @type {MutationObserver|null} Observer for ad detection */
    this._adObserver = null;

    // ── Command Queuing ───────────────────────────────────────
    /** @type {Array<object>} Queue for remote commands received before video is ready */
    this._commandQueue = [];

    // ── Lifecycle ─────────────────────────────────────────────
    /** @type {AbortController} For cleaning up all event listeners */
    this._abortController = new AbortController();
    /** @type {boolean} Whether the adapter is attached and active */
    this._attached = false;
  }

  /**
   * Attach to a YouTube <video> element and set up all event listeners.
   * @param {HTMLVideoElement} videoElement
   */
  attach(videoElement) {
    if (this._attached) {
      console.warn('[YouTubeAdapter] Already attached — call destroy() first');
      return;
    }

    this._video = videoElement;
    this._attached = true;
    this._currentVideoId = this.getVideoId();

    this._setupVideoListeners();
    this._setupVideoIdPolling();
    this._setupAdObserver();

    console.log(
      `[YouTubeAdapter] Attached to <video> element — ` +
      `videoId=${this._currentVideoId}, ` +
      `duration=${this._video.duration.toFixed(1)}s, ` +
      `readyState=${this._video.readyState}`
    );
  }

  // ══════════════════════════════════════════════════════════════
  //  VideoAdapter Interface Implementation
  // ══════════════════════════════════════════════════════════════

  play() {
    if (!this._video || this._isAdPlaying()) return;

    // Layer 1 Echo Suppression: already playing → no-op, no event, no echo.
    if (!this._video.paused) return;

    // Layer 2 Echo Suppression: set flag before DOM call
    this._remotePlayPending = true;
    
    this._video.play().catch((err) => {
      // Reset flag if play was rejected (e.g., browser autoplay policy).
      this._remotePlayPending = false;
      if (err.name !== 'AbortError') {
        console.warn('[YouTubeAdapter] play() rejected:', err.name);
      }
    });
  }

  pause() {
    if (!this._video || this._isAdPlaying()) return;

    // Layer 1 Echo Suppression: already paused → no-op
    if (this._video.paused) return;

    // Layer 2 Echo Suppression: set flag before DOM call
    this._remotePausePending = true;
    this._video.pause();
  }

  seek(time) {
    if (!this._video || this._isAdPlaying()) return;

    const duration = this._video.duration;
    if (isFinite(duration)) {
      time = Math.max(0, Math.min(time, duration));
    }

    // Layer 1 Echo Suppression: skip if already within 0.5s of target position
    if (Math.abs(this._video.currentTime - time) < 0.5) return;

    // Layer 2 Echo Suppression: mark as programmatic seek
    this._isProgrammaticSeek = true;
    this._video.currentTime = time;
  }

  getCurrentTime() {
    return this._video ? this._video.currentTime : 0;
  }

  getDuration() {
    return this._video ? this._video.duration : 0;
  }

  isPaused() {
    return this._video ? this._video.paused : true;
  }

  getVideoId() {
    try {
      const url = new URL(window.location.href);

      // Standard watch page: youtube.com/watch?v=VIDEO_ID
      const vParam = url.searchParams.get('v');
      if (vParam) return vParam;

      // Shorts: youtube.com/shorts/VIDEO_ID
      const shortsMatch = url.pathname.match(/\/shorts\/([a-zA-Z0-9_-]+)/);
      if (shortsMatch) return shortsMatch[1];

      // Embed: youtube.com/embed/VIDEO_ID
      const embedMatch = url.pathname.match(/\/embed\/([a-zA-Z0-9_-]+)/);
      if (embedMatch) return embedMatch[1];

      return null;
    } catch {
      return null;
    }
  }

  isReady() {
    // readyState >= 2 (HAVE_CURRENT_DATA) means at least the current frame is available
    return this._video !== null && this._video.readyState >= 2;
  }

  onUserPlay(callback) { this._onPlayCallback = callback; }
  onUserPause(callback) { this._onPauseCallback = callback; }
  onUserSeek(callback) { this._onSeekCallback = callback; }
  onVideoChange(callback) { this._onVideoChangeCallback = callback; }
  onInterruptionStart(callback) { this._onInterruptionStartCallback = callback; }
  onInterruptionEnd(callback) { this._onInterruptionEndCallback = callback; }

  /**
   * Apply a remote command with echo suppression.
   * If the video is not ready, queues the command until HAVE_CURRENT_DATA.
   *
   * @param {object} command - A SyncCommand instance with execute() method
   */
  applyRemoteCommand(command) {
    if (!this.isReady()) {
      console.log(`[YouTubeAdapter] Video not ready. Queuing command:`, command.constructor.name);
      this._commandQueue.push(command);
      return;
    }
    
    // Echo suppression handled internally by play/pause/seek DOM overrides
    command.execute(this);
  }

  /**
   * Flushes any queued commands that arrived while the video was buffering
   * @private
   */
  _processCommandQueue() {
    if (this._commandQueue.length === 0 || !this.isReady()) return;
    
    console.log(`[YouTubeAdapter] Video ready. Processing ${this._commandQueue.length} queued commands.`);
    while (this._commandQueue.length > 0) {
      const cmd = this._commandQueue.shift();
      cmd.execute(this);
    }
  }

  destroy() {
    this._attached = false;
    this._abortController.abort(); // Clears all bound DOM events

    if (this._seekDebounceTimer !== null) {
      clearTimeout(this._seekDebounceTimer);
      this._seekDebounceTimer = null;
    }

    if (this._videoIdPollInterval !== null) {
      clearInterval(this._videoIdPollInterval);
      this._videoIdPollInterval = null;
    }

    if (this._adObserver) {
      this._adObserver.disconnect();
      this._adObserver = null;
    }

    this._commandQueue = []; // Clear queue to prevent memory leaks
    this._remotePlayPending = false;
    this._remotePausePending = false;
    this._video = null;

    this._onPlayCallback = null;
    this._onPauseCallback = null;
    this._onSeekCallback = null;
    this._onVideoChangeCallback = null;
    this._onInterruptionStartCallback = null;
    this._onInterruptionEndCallback = null;

    console.log('[YouTubeAdapter] Destroyed');
  }

  // ══════════════════════════════════════════════════════════════
  //  YouTube-Specific Helpers
  // ══════════════════════════════════════════════════════════════

  /**
   * Check if the current moment is within the initial page-load window.
   * @returns {boolean} true if the event is likely from the user (post-load)
   */
  isUserGenerated() {
    return Date.now() > this._suppressUntil;
  }

  /**
   * @returns {boolean} True if a YouTube ad is currently playing.
   */
  _isAdPlaying() {
    return this._isAdActive;
  }

  /**
   * Evaluate combined interruption state and fire callbacks.
   * @private
   */
  _evaluateInterruptionState() {
    const isNowInterrupted = this._isBuffering || this._isAdActive;
    if (isNowInterrupted !== this._isInterrupted) {
      this._isInterrupted = isNowInterrupted;
      if (this._isInterrupted) {
        console.log(`[YouTubeAdapter] Interruption START (Buffer: ${this._isBuffering}, Ad: ${this._isAdActive})`);
        if (this._onInterruptionStartCallback) this._onInterruptionStartCallback();
      } else {
        console.log(`[YouTubeAdapter] Interruption END`);
        if (this._onInterruptionEndCallback) this._onInterruptionEndCallback();
      }
    }
  }

  /**
   * Detects if the internal <video> state represents an automated buffer pause.
   * @returns {boolean}
   * @private
   */
  _isBufferingPause() {
    if (!this._video) return false;
    return this._isBuffering || this._video.readyState < 3;
  }

  // ══════════════════════════════════════════════════════════════
  //  Event Listeners
  // ══════════════════════════════════════════════════════════════

  /**
   * Set up all DOM event listeners on the <video> element.
   * @private
   */
  _setupVideoListeners() {
    if (!this._video) return;
    const signal = this._abortController.signal;

    // ── Command Queue Flush ─────────────────────────────────
    this._video.addEventListener('canplay', () => this._processCommandQueue(), { signal });
    this._video.addEventListener('loadeddata', () => this._processCommandQueue(), { signal });

    // ── Play Event ──────────────────────────────────────────
    this._video.addEventListener('play', () => {
      // Consume programmatic flag
      if (this._remotePlayPending) {
        this._remotePlayPending = false;
        return;
      }
      if (!this.isUserGenerated() || this._isAdPlaying()) return;

      console.log('[YouTubeAdapter] User PLAY detected at', this._video.currentTime.toFixed(2));
      if (this._onPlayCallback) this._onPlayCallback();
    }, { signal });

    // ── Pause Event ─────────────────────────────────────────
    this._video.addEventListener('pause', () => {
      // Consume programmatic flag
      if (this._remotePausePending) {
        this._remotePausePending = false;
        return;
      }
      if (!this.isUserGenerated() || this._isAdPlaying() || this._video.ended || this._isBufferingPause()) return;

      console.log('[YouTubeAdapter] User PAUSE detected at', this._video.currentTime.toFixed(2));
      if (this._onPauseCallback) this._onPauseCallback();
    }, { signal });

    // ── Seeking Event ───────────────────────────────────────
    this._video.addEventListener('seeking', () => {
      if (!this._isSeeking) {
        this._preSeekTime = this._video.currentTime;
        this._isSeeking = true;
      }
    }, { signal });

    // ── Seeked Event ────────────────────────────────────────
    this._video.addEventListener('seeked', () => {
      // Skip & consume programmatic seek flag
      if (this._isProgrammaticSeek) {
        this._isProgrammaticSeek = false;
        this._isSeeking = false;
        return;
      }

      if (!this.isUserGenerated() || this._isAdPlaying()) {
        this._isSeeking = false;
        return;
      }

      // Debounce window to coalesce fast scrubs
      if (this._seekDebounceTimer !== null) clearTimeout(this._seekDebounceTimer);

      this._seekDebounceTimer = setTimeout(() => {
        this._seekDebounceTimer = null;
        this._isSeeking = false;

        const newTime = this._video.currentTime;
        const delta = Math.abs(newTime - this._preSeekTime);

        // Filter out microscopic position corrections (< 1s)
        if (delta > 1.0) {
          console.log(`[YouTubeAdapter] User SEEK detected: ${this._preSeekTime.toFixed(2)} → ${newTime.toFixed(2)} (Δ${delta.toFixed(2)}s)`);
          if (this._onSeekCallback) this._onSeekCallback(newTime);
        }
      }, this._seekDebounceMs);
    }, { signal });

    // ── Buffering Detection ─────────────────────────────────
    this._video.addEventListener('waiting', () => {
      this._isBuffering = true;
      this._evaluateInterruptionState();
    }, { signal });

    this._video.addEventListener('playing', () => {
      this._isBuffering = false;
      this._evaluateInterruptionState();
    }, { signal });
  }

  // ══════════════════════════════════════════════════════════════
  //  Video ID & Ad Change Detection
  // ══════════════════════════════════════════════════════════════

  /**
   * Set up an observer to watch for YouTube ad classes.
   * @private
   */
  _setupAdObserver() {
    const player = this._video ? this._video.closest('.html5-video-player') || document.querySelector('.html5-video-player') : null;
    if (!player) return;

    this._isAdActive = player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting');
    this._evaluateInterruptionState();

    this._adObserver = new MutationObserver(() => {
      const adActive = player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting');
      if (adActive !== this._isAdActive) {
        this._isAdActive = adActive;
        this._evaluateInterruptionState();
      }
    });

    this._adObserver.observe(player, { attributes: true, attributeFilter: ['class'] });
  }

  /**
   * Poll for video ID changes since YouTube uses SPA navigation.
   * @private
   */
  _setupVideoIdPolling() {
    this._videoIdPollInterval = setInterval(() => {
      const newId = this.getVideoId();
      if (newId && newId !== this._currentVideoId) {
        const oldId = this._currentVideoId;
        this._currentVideoId = newId;
        console.log(`[YouTubeAdapter] Video changed: ${oldId} → ${newId}`);
        if (this._onVideoChangeCallback) this._onVideoChangeCallback(newId);
      }
    }, 1000);
  }

  /**
   * Manually trigger a video ID check (called on yt-navigate-finish).
   */
  checkVideoIdChange() {
    const newId = this.getVideoId();
    if (newId && newId !== this._currentVideoId) {
      const oldId = this._currentVideoId;
      this._currentVideoId = newId;
      console.log(`[YouTubeAdapter] Video changed (nav event): ${oldId} → ${newId}`);
      if (this._onVideoChangeCallback) this._onVideoChangeCallback(newId);
    }
  }

  // ══════════════════════════════════════════════════════════════
  //  Debug / Inspection
  // ══════════════════════════════════════════════════════════════

  /**
   * Get a snapshot of the adapter's internal state for debugging.
   * @returns {object}
   */
  getDebugState() {
    return {
      attached: this._attached,
      videoId: this._currentVideoId,
      currentTime: this._video ? this._video.currentTime : null,
      duration: this._video ? this._video.duration : null,
      paused: this._video ? this._video.paused : null,
      readyState: this._video ? this._video.readyState : null,
      isBuffering: this._isBuffering,
      isSeeking: this._isSeeking,
      isProgrammaticSeek: this._isProgrammaticSeek,
      isAdPlaying: this._isAdPlaying(),
      remotePlayPending: this._remotePlayPending,
      remotePausePending: this._remotePausePending,
      queuedCommands: this._commandQueue.length,
      pageLoadSuppression: Date.now() <= this._suppressUntil,
    };
  }
};