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
  const transportChip = document.getElementById('transportChip');
  const latencyChip = document.getElementById('latencyChip');

  /** @type {number|null} Poll timer for link diagnostics while the popup is open */
  let statusPollId = null;

  /** @type {boolean} Whether the last render showed a room, so we can spot leaving one */
  let wasInRoom = false;

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
      
      const others = Math.max(0, (status.peerCount || 1) - 1);
      const company = others === 0
        ? 'alone'
        : `with ${others} other${others === 1 ? '' : 's'}`;

      if (status.isHost) {
        peerCount.textContent = `★ Host · ${company}`;
        peerCount.classList.add('host');
      } else {
        peerCount.textContent = `Participant · ${company}`;
        peerCount.classList.remove('host');
      }

      updateLinkInfo(status);
    } else {
      viewDisconnected.classList.remove('hidden');
      viewConnected.classList.add('hidden');

      // Clear only on the transition out of a room, never on a plain re-render.
      // Status is polled every 2s to keep the transport and RTT readings live,
      // and clearing unconditionally wiped whatever the user was mid-way
      // through typing.
      if (wasInRoom) inputRoomCode.value = '';
    }

    wasInRoom = Boolean(status.roomId);
  }

  /**
   * Show which transport is carrying commands and how far away the host is.
   *
   * The hybrid transport is the interesting part of this system and is
   * otherwise completely invisible — without this you cannot tell whether P2P
   * actually came up or whether the room quietly fell back to the relay.
   *
   * @param {object} status
   */
  function updateLinkInfo(status) {
    const transport = status.transport || 'none';

    transportChip.classList.remove('p2p', 'relay');

    if (transport === 'WebRTC') {
      transportChip.textContent = 'P2P · WebRTC';
      transportChip.classList.add('p2p');
      transportChip.title = 'Commands travel directly between peers';
    } else if (transport === 'WebSocket') {
      transportChip.textContent = 'Relay · WebSocket';
      transportChip.classList.add('relay');
      transportChip.title = 'Commands are relayed through the server';
    } else {
      transportChip.textContent = 'No transport';
      transportChip.title = '';
    }

    const rtt = status.rttMs;
    latencyChip.textContent = rtt > 0 ? `${rtt} ms RTT` : 'measuring…';

    // Spell out what the number covers. On the relay it is a four-leg loop
    // (you → server → host → server → you), so it reads about twice as large
    // as a plain ping to the server and invites the conclusion that something
    // is broken. Half of it is the one-way delay compensation actually applies.
    if (rtt > 0 && transport === 'WebRTC') {
      latencyChip.title =
        `Direct round trip to the host peer. ` +
        `Compensation advances playback by ${Math.round(rtt / 2)} ms.`;
    } else if (rtt > 0) {
      latencyChip.title =
        `Round trip through the relay: you → server → host → server → you. ` +
        `Compensation advances playback by ${Math.round(rtt / 2)} ms.`;
    } else {
      latencyChip.title = 'Waiting for the first round-trip sample';
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

  async function refreshStatus() {
    try {
      const status = await sendMessage('GET_STATUS');
      if (status && status.state) {
        updateUI(status);
      }
    } catch (err) {
      console.warn('[Popup] Failed to get status. Service Worker may be asleep:', err);
    }
  }

  async function init() {
    // Read the version rather than hardcoding it in the markup, where it goes
    // stale and makes a freshly reloaded build look like the old one.
    const versionEl = document.getElementById('version');
    if (versionEl) versionEl.textContent = `v${chrome.runtime.getManifest().version}`;

    await refreshStatus();

    // RTT and transport change without any state transition to announce them,
    // so a push-only UI would show a stale reading for as long as the popup
    // stays open. Polling stops with the popup, so it costs nothing when closed.
    statusPollId = setInterval(refreshStatus, 2000);
  }

  window.addEventListener('unload', () => {
    if (statusPollId !== null) clearInterval(statusPollId);
  });

  init();
})();