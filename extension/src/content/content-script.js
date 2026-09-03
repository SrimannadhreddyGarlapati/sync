/**
 * Content Script — Entry Point
 * 
 * Runs in every YouTube tab. Responsibilities:
 *   1. Detect the <video> element (with retry for SPA navigation)
 *   2. Instantiate YouTubeAdapter and OverlayUI
 *   3. Bridge user playback events to the background service worker via IPC
 *   4. Receive remote commands from the service worker and apply them
 * 
 * OS Pillar: This is a sandboxed process — it has DOM access but runs
 * in an isolated JS context. All communication with the background
 * "daemon" happens via chrome.runtime message-passing IPC.
 */

(function () {
  'use strict';

  // ── Constants ───────────────────────────────────────────────
  const VIDEO_DETECT_INTERVAL = 500;  // ms between detection attempts
  const VIDEO_DETECT_MAX_ATTEMPTS = 60; // give up after 30 seconds (60 × 500ms)
  const TAG = '[SyncTube:Content]';

  // ── State ───────────────────────────────────────────────────
  /** @type {InstanceType<window.SyncTube.YouTubeAdapter>|null} */
  let adapter = null;

  /** @type {InstanceType<window.SyncTube.OverlayUI>|null} */
  let overlay = null;

  /** @type {boolean} */
  let initialized = false;

  /** @type {string} Track current URL for SPA navigation detection */
  let lastUrl = location.href;

  /** @type {string|null} Track current video ID */
  let currentVideoId = null;

  /**
   * Whether the extension context is still valid.
   * When the extension is reloaded/updated, Chrome invalidates the
   * old content script's runtime connection.
   * @type {boolean}
   */
  let contextValid = true;

  /**
   * Check if the extension context is still alive.
   * @returns {boolean}
   */
  function isContextValid() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  /**
   * Handle a dead extension context. Tear down everything safely.
   */
  function handleContextInvalidated() {
    if (!contextValid) return; 
    contextValid = false;

    console.warn(`${TAG} Extension context invalidated — cleaning up. Refresh the page to reconnect.`);
    cleanup();
  }

  // ══════════════════════════════════════════════════════════════
  //  Video Element Detection
  // ══════════════════════════════════════════════════════════════

  /**
   * Attempt to find the YouTube <video> element via polling.
   */
  function detectVideo() {
    let attempts = 0;

    const tryFind = () => {
      if (!contextValid) return; // Bail if context died

      // Prefer the class-specific selector to avoid matching ad/preview videos.
      const video = document.querySelector('video.html5-main-video')
        || document.querySelector('#movie_player video')
        || document.querySelector('video');

      if (video && video.readyState >= 0) {
        // Verify it's actually YouTube's main player
        const player = video.closest('.html5-video-player');
        if (player || video.classList.contains('html5-main-video')) {
          onVideoFound(video);
          return;
        }
      }

      attempts++;
      if (attempts < VIDEO_DETECT_MAX_ATTEMPTS) {
        setTimeout(tryFind, VIDEO_DETECT_INTERVAL);
      } else {
        console.warn(`${TAG} Could not find <video> after ${VIDEO_DETECT_MAX_ATTEMPTS} attempts.`);
      }
    };

    tryFind();
  }

  /**
   * Called when the <video> element is found. Sets up the adapter & overlay.
   * @param {HTMLVideoElement} videoElement
   */
  function onVideoFound(videoElement) {
    if (initialized) return;

    if (!isContextValid()) {
      handleContextInvalidated();
      return;
    }

    initialized = true;
    currentVideoId = extractVideoId();

    console.log(`${TAG} Video element found — videoId=${currentVideoId}`);

    // ── Initialize Adapter & Overlay ─────────────────────────
    adapter = new window.SyncTube.YouTubeAdapter();
    adapter.attach(videoElement);

    overlay = new window.SyncTube.OverlayUI();
    overlay.inject();

    // ── Wire user actions → IPC to background ────────────────
    // `isPaused` travels with every action so the receiver can decide whether
    // to apply latency compensation. A position that is still advancing must be
    // nudged forward by the network delay; a frozen one must not be.
    adapter.onUserPlay(() => {
      console.log(`${TAG} → Sending PLAY to background`);
      sendToBackground('SYNC_ACTION', {
        type: 'PLAY',
        data: {
          videoTime: adapter.getCurrentTime(),
          videoId: adapter.getVideoId(),
          isPaused: false,
        },
      });
    });

    adapter.onUserPause(() => {
      console.log(`${TAG} → Sending PAUSE to background`);
      sendToBackground('SYNC_ACTION', {
        type: 'PAUSE',
        data: {
          videoTime: adapter.getCurrentTime(),
          videoId: adapter.getVideoId(),
          isPaused: true,
        },
      });
    });

    adapter.onUserSeek((newTime) => {
      console.log(`${TAG} → Sending SEEK to background (t=${newTime.toFixed(2)})`);
      sendToBackground('SYNC_ACTION', {
        type: 'SEEK',
        data: {
          videoTime: newTime,
          videoId: adapter.getVideoId(),
          isPaused: adapter.isPaused(),
        },
      });
    });

    adapter.onVideoChange((newVideoId) => {
      console.log(`${TAG} → Video changed to ${newVideoId}`);
      currentVideoId = newVideoId;
      sendToBackground('VIDEO_CHANGED', { videoId: newVideoId });
    });

    adapter.onInterruptionStart(() => {
      console.log(`${TAG} → Sending INTERRUPTION_START to background`);
      sendToBackground('INTERRUPTION_START', {
        videoTime: adapter.getCurrentTime(), videoId: adapter.getVideoId(),
      });
    });

    adapter.onInterruptionEnd(() => {
      console.log(`${TAG} → Sending INTERRUPTION_END to background`);
      sendToBackground('INTERRUPTION_END', {
        videoTime: adapter.getCurrentTime(), videoId: adapter.getVideoId(),
      });
    });

    // ── Request current status from background ───────────────
    sendToBackground('GET_STATUS', {}, (response) => {
      if (response && response.success) overlay.updateStatus(response);
    });
  }

  // ══════════════════════════════════════════════════════════════
  //  IPC — Message Passing to Background Service Worker
  // ══════════════════════════════════════════════════════════════

  /**
   * Send a message to the background service worker safely.
   */
  function sendToBackground(action, payload = {}, callback = null) {
    if (!contextValid) return;

    if (!isContextValid()) {
      handleContextInvalidated();
      return;
    }

    try {
      chrome.runtime.sendMessage({ action, payload }, (response) => {
        if (chrome.runtime.lastError) {
          const errorMsg = chrome.runtime.lastError.message || '';
          if (errorMsg.includes('Extension context invalidated')) {
            handleContextInvalidated();
            return;
          }
          // Quietly ignore typical transient disconnected SW errors
          return;
        }
        if (callback) callback(response);
      });
    } catch (err) {
      if (err.message && err.message.includes('Extension context invalidated')) {
        handleContextInvalidated();
      } else {
        console.error(`${TAG} Unexpected IPC error:`, err);
      }
    }
  }

  // ══════════════════════════════════════════════════════════════
  //  IPC — Incoming Messages from Background Service Worker
  // ══════════════════════════════════════════════════════════════

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!contextValid) return false;

    const { action, payload } = message;

    switch (action) {
      case 'APPLY_COMMAND': {
        if (!payload || !payload.type || !payload.command) {
          sendResponse({ success: false });
          break;
        }

        if (adapter) {
          // VideoId mismatch guard: skips if targeting a different video
          const cmdVideoId = payload.command.videoId;
          if (cmdVideoId && payload.type !== 'ROOM_STATE' && cmdVideoId !== adapter.getVideoId()) {
            console.log(`${TAG} Ignoring ${payload.type} — videoId mismatch`);
            sendResponse({ success: true });
            break;
          }

          const cmd = window.SyncTube.ClientCommandFactory.fromWireMessage(payload);
          if (cmd) adapter.applyRemoteCommand(cmd);
        }
        sendResponse({ success: true });
        break;
      }

      case 'UPDATE_STATUS': {
        if (overlay) overlay.updateStatus(payload);
        sendResponse({ success: true });
        break;
      }

      case 'SHOW_TOAST': {
        if (overlay) overlay.showToast(payload.text, payload.duration);
        sendResponse({ success: true });
        break;
      }

      case 'GET_VIDEO_STATE': {
        if (adapter) {
          sendResponse({
            success: true,
            videoState: {
              videoTime: adapter.getCurrentTime(),
              duration: adapter.getDuration(),
              videoId: adapter.getVideoId(),
              isPaused: adapter.isPaused(),
              isReady: adapter.isReady(),
            },
          });
        } else {
          sendResponse({ success: true, videoState: null });
        }
        break;
      }

      case 'GET_DEBUG_STATE': {
        sendResponse({
          success: true,
          debugState: adapter ? adapter.getDebugState() : null,
        });
        break;
      }

      default:
        sendResponse({ success: false, error: `Unknown action: ${action}` });
    }
  });

  // ══════════════════════════════════════════════════════════════
  //  SPA Navigation Handling
  // ══════════════════════════════════════════════════════════════

  /**
   * Extract video ID from the current URL, accounting for Shorts/Embeds.
   * @returns {string|null}
   */
  function extractVideoId() {
    try {
      const url = new URL(window.location.href);
      
      // Standard Watch Pages
      const v = url.searchParams.get('v');
      if (v) return v;

      // Shorts, Embeds, and Live Streams
      const path = url.pathname;
      if (path.startsWith('/shorts/')) return path.split('/shorts/')[1];
      if (path.startsWith('/embed/')) return path.split('/embed/')[1];
      if (path.startsWith('/live/')) return path.split('/live/')[1];

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Handle a YouTube SPA navigation.
   * Clean up the old adapter/overlay and re-detect the video on the new page.
   */
  function handleNavigation() {
    if (!contextValid) return;

    const newUrl = location.href;
    if (newUrl === lastUrl) return;

    lastUrl = newUrl;
    const newVideoId = extractVideoId();

    console.log(`${TAG} SPA navigation: ${newUrl} (videoId=${newVideoId})`);

    if (newVideoId !== currentVideoId || !newVideoId) {
      cleanup();
      if (isVideoPage()) detectVideo();
    } else if (adapter) {
      adapter.checkVideoIdChange();
    }
  }

  /**
   * Check if the current page is a YouTube video page.
   * @returns {boolean}
   */
  function isVideoPage() {
    const path = location.pathname;
    return path.startsWith('/watch') ||
           path.startsWith('/shorts/') ||
           path.startsWith('/live/') ||
           path.startsWith('/embed/');
  }

  /**
   * Clean up adapter and overlay for re-initialization.
   */
  function cleanup() {
    if (adapter) {
      adapter.destroy();
      adapter = null;
    }
    if (overlay) {
      overlay.destroy();
      overlay = null;
    }
    initialized = false;
    currentVideoId = null;
  }

  // ── Strategy 1: YouTube's Native Navigation Events ─────────
  // These fire reliably after YouTube's internal SPA router transitions.
  document.addEventListener('yt-navigate-finish', handleNavigation);
  document.addEventListener('yt-page-data-updated', handleNavigation);

  // ── Strategy 2: MutationObserver on <title> ────────────────
  // Fallback for cases where custom events get blocked.
  const titleObserver = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      handleNavigation();
    }
  });

  const titleElement = document.querySelector('title');
  if (titleElement) {
    titleObserver.observe(titleElement, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  }

  // ── Strategy 3: Standard Popstate ──────────────────────────
  window.addEventListener('popstate', () => {
    setTimeout(handleNavigation, 0);
  });

  // ══════════════════════════════════════════════════════════════
  //  Initialization
  // ══════════════════════════════════════════════════════════════

  console.log(`${TAG} Content script loaded on ${location.href}`);

  if (isVideoPage()) {
    detectVideo();
  } else {
    console.log(`${TAG} Not a video page — waiting for navigation`);
  }
})();