/**
 * Background Service Worker — Entry Point
 * 
 * Event-driven daemon that routes IPC messages between the content
 * script, popup, and the SyncEngine. Follows MV3 best practices:
 *   - No global mutable state (everything in chrome.storage)
 *   - All event listeners registered at top level (synchronously)
 *   - Async work uses the IIFE pattern with return true
 * 
 * OS Pillar: This mirrors a system daemon — spawned by the OS (Chrome),
 * can be killed and respawned at any time, communicates exclusively
 * via message-passing IPC (chrome.runtime).
 */

import { SyncEngine } from './SyncEngine.js';

// ─── Singleton SyncEngine instance ──────────────────────────────
// Note: This variable is re-initialized each time the SW wakes up.
// Actual state is restored from chrome.storage.session inside init().
let engine = null;

/**
 * Ensure the engine is initialized before handling any message.
 * @returns {Promise<SyncEngine>}
 */
async function getEngine() {
  if (!engine) {
    engine = new SyncEngine();
    await engine.init();
  }
  return engine;
}

// ─── IPC Message Handler ────────────────────────────────────────
// All chrome.runtime.onMessage listeners MUST be registered
// synchronously at the top level of the service worker.

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Use async IIFE — return true to keep the message channel open
  (async () => {
    try {
      const eng = await getEngine();
      const response = await handleMessage(eng, message, sender);
      sendResponse(response);
    } catch (err) {
      console.error('[ServiceWorker] Error handling message:', err);
      sendResponse({ success: false, error: err.message });
    }
  })();

  // Keep the message channel open for async response
  return true;
});

/**
 * Route an IPC message to the appropriate SyncEngine method.
 * 
 * @param {SyncEngine} eng
 * @param {object} message - { action: string, payload?: object }
 * @param {chrome.runtime.MessageSender} sender
 * @returns {Promise<object>} Response to send back
 */
async function handleMessage(eng, message, sender) {
  const { action, payload } = message;

  // For any action that sends network commands, ensure the connection is active
  // just in case the service worker woke up from idle sleep.
  if (['SYNC_ACTION', 'FORCE_SYNC', 'VIDEO_CHANGED', 'INTERRUPTION_START', 'INTERRUPTION_END'].includes(action)) {
    await eng.ensureConnection();
  }

  switch (action) {
    // ── Room Management ──
    case 'CREATE_ROOM': {
      const result = await eng.createRoom();
      return { success: true, ...result };
    }

    case 'JOIN_ROOM': {
      const result = await eng.joinRoom(payload.roomId);
      return { success: true, ...result };
    }

    case 'LEAVE_ROOM': {
      await eng.leaveRoom();
      return { success: true };
    }

    // ── Status Query ──
    case 'GET_STATUS': {
      const status = eng.getStatus();
      return { success: true, ...status };
    }

    // ── Sync Actions from Content Script ──
    case 'SYNC_ACTION': {
      eng.sendAction(payload.type, payload.data || {});
      return { success: true };
    }

    // ── Force Sync (from popup) ──
    // Triggers a full state reconciliation via ROOM_STATE.
    // This respects isPaused (unlike the old empty FORCE_SYNC command).
    case 'FORCE_SYNC': {
      if (eng.isHost) {
        // Host: query own tab state and broadcast ROOM_STATE to all peers.
        const tabs = await chrome.tabs.query({ url: '*://*.youtube.com/*' });
        
        for (const tab of tabs) {
          try {
            const response = await chrome.tabs.sendMessage(tab.id, { action: 'GET_VIDEO_STATE' });
            if (response?.success && response?.videoState?.videoId) {
              eng.sendAction('ROOM_STATE', {
                videoId: response.videoState.videoId,
                videoTime: response.videoState.videoTime,
                isPaused: response.videoState.isPaused,
              });
              break; // Stop after successfully querying the first active, responding tab
            }
          } catch (err) {
            // Expected if the tab is loading or the content script isn't fully injected.
            // Move to the next tab.
            continue;
          }
        }
      } else {
        // Joiner: ask the host for current state.
        eng.sendAction('REQUEST_STATE', {});
      }
      return { success: true };
    }

    // ── Video Navigation ──
    case 'VIDEO_CHANGED': {
      console.log(`[ServiceWorker] Video changed to: ${payload.videoId}`);
      
      // ONLY the host should dictate the ROOM_STATE when the video changes.
      // If a Joiner navigates, they must ask the Host for the current time and state.
      if (!eng.isHost) {
        console.log(`[ServiceWorker] Non-host navigated. Requesting state from host.`);
        eng.sendAction('REQUEST_STATE', {});
        return { success: true };
      }

      // Query the tab for actual playback state, then notify peers.
      // The content script fires this after YouTube's SPA navigation,
      // so the video element may already be playing at a non-zero time.
      if (eng.roomId && sender.tab?.id) {
        try {
          const response = await chrome.tabs.sendMessage(sender.tab.id, { action: 'GET_VIDEO_STATE' });
          if (response?.success && response?.videoState) {
            eng.sendAction('ROOM_STATE', {
              videoId: payload.videoId,
              videoTime: response.videoState.videoTime,
              isPaused: response.videoState.isPaused,
            });
          } else {
            throw new Error("Invalid or missing video state in response");
          }
        } catch (err) {
          // Fallback if the adapter isn't ready yet (new video still loading)
          eng.sendAction('ROOM_STATE', {
            videoId: payload.videoId,
            videoTime: 0,
            isPaused: true,
          });
        }
      }
      return { success: true };
    }

    // ── Interruptions (Ads, Buffering) ──
    case 'INTERRUPTION_START': {
      if (eng.roomId) {
        eng.interruptionModule.handleInterruptionStart(sender.tab?.id, payload.videoId, payload.videoTime);
      }
      return { success: true };
    }

    case 'INTERRUPTION_END': {
      if (eng.roomId) {
        eng.interruptionModule.handleInterruptionEnd(sender.tab?.id, payload.videoId, payload.videoTime);
      }
      return { success: true };
    }

    default:
      console.warn(`[ServiceWorker] Unknown action: "${action}"`);
      return { success: false, error: `Unknown action: ${action}` };
  }
}

// ─── Extension Install / Update ─────────────────────────────────

chrome.runtime.onInstalled.addListener((details) => {
  console.log(`[SyncTube] Extension ${details.reason}: v${chrome.runtime.getManifest().version}`);
});

console.log('[SyncTube] Service worker loaded');