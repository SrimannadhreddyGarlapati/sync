/**
 * Popup Script — Extension Popup UI Logic
 * 
 * Handles user interactions in the popup and communicates with
 * the background service worker via chrome.runtime.sendMessage IPC.
 * 
 * Complies with MV3 architecture. Ensures state changes broadcasted
 * by the SyncEngine (_broadcastStatusUpdate) update the UI in real-time.
 */

(function () {
  'use strict';

  // ── DOM Elements ────────────────────────────────────────────
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const viewDisconnected = document.getElementById('viewDisconnected');
  const viewConnected = document.getElementById('viewConnected');
  const btnCreate = document.getElementById('btnCreate');
  const btnJoin = document.getElementById('btnJoin');
  const inputRoomCode = document.getElementById('inputRoomCode');
  const errorMsg = document.getElementById('errorMsg');
  const roomCode = document.getElementById('roomCode');
  const peerCount = document.getElementById('peerCount');
  const btnForceSync = document.getElementById('btnForceSync');
  const btnLeave = document.getElementById('btnLeave');

  // ── IPC Helper ──────────────────────────────────────────────

  /**
   * Send a message to the background service worker and return the response.
   * Handles native runtime errors and explicitly propagated payload errors.
   * @param {string} action
   * @param {object} payload
   * @returns {Promise<object>}
   */
  function sendMessage(action, payload = {}) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action, payload }, (response) => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        if (response && response.error) {
          return reject(new Error(response.error));
        }
        resolve(response || {});
      });
    });
  }

  // ── UI Updates ──────────────────────────────────────────────

  /**
   * Update the popup UI based on the engine status.
   * @param {object} status - Matches `{peerId, roomId, isHost, state, connected}`
   */
  function updateUI(status) {
    if (!status) return;

    // Update status bar
    const stateLabels = {
      DISCONNECTED: 'Not connected',
      JOINING: 'Joining room…',
      SYNCING: 'Syncing…',
      SYNCED: 'In sync',
      DRIFTING: 'Resyncing…',
      RECONNECTING: 'Reconnecting…',
    };

    const state = status.state || 'DISCONNECTED';
    statusText.textContent = stateLabels[state] || state;
    statusDot.className = 'status-dot ' + state.toLowerCase();

    // Show correct view based on room presence
    if (status.roomId) {
      viewDisconnected.classList.add('hidden');
      viewConnected.classList.remove('hidden');
      roomCode.textContent = status.roomId;
      
      if (status.isHost) {
        peerCount.textContent = '★ You are the Host';
        peerCount.classList.add('host');
      } else {
        peerCount.textContent = 'Participant';
        peerCount.classList.remove('host');
      }
    } else {
      viewDisconnected.classList.remove('hidden');
      viewConnected.classList.add('hidden');
      inputRoomCode.value = ''; // Clear on disconnect
    }
  }

  /**
   * Show an error message below the join input.
   * @param {string} text
   */
  function showError(text) {
    errorMsg.textContent = text;
    errorMsg.style.display = 'block';
    setTimeout(() => {
      errorMsg.style.display = 'none';
    }, 4000);
  }

  // ── Event Handlers ──────────────────────────────────────────

  btnCreate.addEventListener('click', async () => {
    btnCreate.disabled = true;
    try {
      const response = await sendMessage('CREATE_ROOM');
      // Blueprint: eng.createRoom() returns {roomId, peerId}
      if (response.roomId) {
        // Optimistically update UI; the state machine update will follow shortly
        updateUI({ roomId: response.roomId, state: 'JOINING', isHost: true });
      }
    } catch (err) {
      showError(err.message || 'Failed to create room');
    } finally {
      btnCreate.disabled = false;
    }
  });

  btnJoin.addEventListener('click', async () => {
    const code = inputRoomCode.value.trim().toUpperCase();
    
    // Blueprint dictates valid room codes are ≥ 4 chars (standardizing at 6)
    if (!code || code.length < 4) {
      showError('Enter a valid room code');
      return;
    }

    btnJoin.disabled = true;
    try {
      const response = await sendMessage('JOIN_ROOM', { roomId: code });
      // Blueprint: eng.joinRoom() returns {roomId, peerId}
      if (response.roomId) {
        updateUI({ roomId: response.roomId, state: 'JOINING', isHost: false });
      }
    } catch (err) {
      showError(err.message || 'Failed to join room');
    } finally {
      btnJoin.disabled = false;
    }
  });

  // Allow Enter key to join
  inputRoomCode.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      btnJoin.click();
    }
  });

  btnForceSync.addEventListener('click', async () => {
    btnForceSync.disabled = true;
    const originalText = btnForceSync.textContent;
    btnForceSync.textContent = 'Sync Broadcasted ✓';
    
    try {
      await sendMessage('FORCE_SYNC');
    } catch (err) {
      console.warn('[Popup] Force sync error:', err);
    } finally {
      setTimeout(() => {
        btnForceSync.textContent = originalText;
        btnForceSync.disabled = false;
      }, 1500);
    }
  });

  btnLeave.addEventListener('click', async () => {
    btnLeave.disabled = true;
    try {
      // Blueprint: leaveRoom() returns void. Ensure cleanup.
      await sendMessage('LEAVE_ROOM');
      updateUI({ state: 'DISCONNECTED', roomId: null });
    } catch (err) {
      console.warn('[Popup] Leave error:', err);
    } finally {
      btnLeave.disabled = false;
    }
  });

  // ── Live Updates Listener ───────────────────────────────────
  
  // Listen for 'UPDATE_STATUS' emitted by SyncEngine._broadcastStatusUpdate()
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'UPDATE_STATUS' && message.payload) {
      updateUI(message.payload);
    }
  });

  // ── Initialization ──────────────────────────────────────────

  async function init() {
    try {
      // Blueprint: GET_STATUS returns {peerId, roomId, isHost, state, connected}
      const status = await sendMessage('GET_STATUS');
      if (status && status.state) {
        updateUI(status);
      }
    } catch (err) {
      console.warn('[Popup] Failed to get status. Service Worker may be asleep:', err);
    }
  }

  init();
})();