/**
 * OverlayUI — On-Page Overlay for Sync Status
 * 
 * Injects a minimal overlay onto the YouTube page showing:
 *   - Connection status badge (synced/drifting/disconnected)
 *   - Room code
 *   - "Resyncing…" toast on drift correction
 */

window.SyncTube = window.SyncTube || {};

window.SyncTube.OverlayUI = class OverlayUI {
  constructor() {
    /** @type {HTMLElement|null} */
    this._container = null;
    
    /** @type {HTMLElement|null} */
    this._badge = null;
    /** @type {HTMLElement|null} */
    this._badgeDot = null;
    /** @type {HTMLElement|null} */
    this._badgeText = null;
    
    /** @type {HTMLElement|null} */
    this._toast = null;

    // Timer references to prevent overlapping toast animations
    this._toastTimeout = null;
    this._toastHideTimeout = null;
  }

  /**
   * Inject the overlay into the page DOM.
   */
  inject() {
    if (this._container) return; // Already injected

    // Main Container
    this._container = document.createElement('div');
    this._container.id = 'synctube-overlay';
    this._container.style.cssText = `
      position: fixed;
      top: 12px;
      right: 12px;
      z-index: 999999;
      font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
      font-size: 13px;
      pointer-events: none;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
    `;

    // Status Badge Container
    this._badge = document.createElement('div');
    this._badge.id = 'synctube-badge';
    this._badge.style.cssText = `
      background: rgba(0, 0, 0, 0.75);
      color: #fff;
      padding: 6px 12px;
      border-radius: 20px;
      display: none;
      align-items: center;
      gap: 8px;
      backdrop-filter: blur(8px);
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      user-select: none;
    `;

    // Status Indicator Dot
    this._badgeDot = document.createElement('span');
    this._badgeDot.style.cssText = `
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #757575;
      display: inline-block;
      flex-shrink: 0;
    `;

    // Room ID Text
    this._badgeText = document.createElement('span');
    this._badgeText.style.cssText = `
      font-weight: 500;
      letter-spacing: 0.5px;
    `;

    // Assemble Badge
    this._badge.appendChild(this._badgeDot);
    this._badge.appendChild(this._badgeText);
    this._container.appendChild(this._badge);

    // Toast Notification Area
    this._toast = document.createElement('div');
    this._toast.id = 'synctube-toast';
    this._toast.style.cssText = `
      margin-top: 8px;
      background: rgba(255, 193, 7, 0.9);
      color: #000;
      padding: 6px 12px;
      border-radius: 8px;
      display: none;
      opacity: 0;
      backdrop-filter: blur(8px);
      transition: opacity 0.3s ease;
      box-shadow: 0 2px 8px rgba(0,0,0,0.2);
      font-weight: 500;
    `;
    this._container.appendChild(this._toast);

    document.body.appendChild(this._container);
    console.log('[SyncTube] OverlayUI Injected');
  }

  /**
   * Update the status badge.
   * @param {object} status - { state, roomId }
   */
  updateStatus(status) {
    if (!this._badge) return;

    if (!status || !status.roomId) {
      this._badge.style.display = 'none';
      return;
    }

    const stateColors = {
      SYNCED: '#4caf50',
      SYNCING: '#2196f3',
      DRIFTING: '#ff9800',
      RECONNECTING: '#f44336',
      JOINING: '#9c27b0',
      DISCONNECTED: '#757575',
    };

    // Use DOM properties instead of innerHTML to prevent XSS vulnerabilities
    this._badgeDot.style.background = stateColors[status.state] || stateColors.DISCONNECTED;
    this._badgeText.textContent = status.roomId;

    // Surface the link on hover. Which transport won and how far away the host
    // is are otherwise invisible, which makes a sync problem hard to place.
    const parts = [status.roomId, status.state];
    if (status.transport && status.transport !== 'none') {
      parts.push(status.transport === 'WebRTC' ? 'P2P' : 'relay');
    }
    if (status.rttMs > 0) parts.push(`${status.rttMs}ms`);
    this._badge.title = `SyncTube · ${parts.join(' · ')}`;

    this._badge.style.display = 'flex';
  }

  /**
   * Show a temporary toast message (e.g., "Resyncing…").
   * @param {string} text
   * @param {number} [durationMs=3000]
   */
  showToast(text, durationMs = 3000) {
    if (!this._toast) return;

    // Clear any existing timeouts to prevent overlapping animations from hiding the new toast
    if (this._toastTimeout) clearTimeout(this._toastTimeout);
    if (this._toastHideTimeout) clearTimeout(this._toastHideTimeout);

    this._toast.textContent = text;
    this._toast.style.display = 'block';

    // Double requestAnimationFrame ensures the browser paints 'display: block' 
    // before applying 'opacity: 1', allowing the CSS transition to actually fire.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (this._toast) this._toast.style.opacity = '1';
      });
    });

    this._toastTimeout = setTimeout(() => {
      if (this._toast) this._toast.style.opacity = '0';
      
      this._toastHideTimeout = setTimeout(() => {
        if (this._toast) this._toast.style.display = 'none';
      }, 300); // Matches the 0.3s CSS transition duration
    }, durationMs);
  }

  /**
   * Remove the overlay from the DOM and clear timers.
   */
  destroy() {
    // Clear pending timers to prevent memory leaks or errors after destruction
    if (this._toastTimeout) clearTimeout(this._toastTimeout);
    if (this._toastHideTimeout) clearTimeout(this._toastHideTimeout);

    if (this._container) {
      this._container.remove();
      this._container = null;
      this._badge = null;
      this._badgeDot = null;
      this._badgeText = null;
      this._toast = null;
    }
  }
};