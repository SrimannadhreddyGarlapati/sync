/**
 * Minimal in-memory stand-in for the extension APIs the background modules use.
 *
 * Enough of chrome.runtime, chrome.tabs, chrome.storage.session and
 * chrome.offscreen to drive SyncEngine and ConnectionManager under Node, so the
 * sync logic can be tested without loading Chrome. Every stub records its calls
 * so tests can assert on what was sent where.
 */

export class ChromeStub {
  constructor() {
    /** @type {Function[]} */
    this.messageListeners = [];

    /** @type {object[]} Messages sent via chrome.runtime.sendMessage */
    this.runtimeMessages = [];

    /** @type {{tabId: number, message: object}[]} Messages sent to tabs */
    this.tabMessages = [];

    /** @type {object[]} Tabs chrome.tabs.query will return */
    this.tabs = [];

    /** @type {object} Backing store for chrome.storage.session */
    this.session = {};

    /** @type {object[]} Tabs created via chrome.tabs.create */
    this.createdTabs = [];

    /** @type {object[]} chrome.tabs.update calls */
    this.updatedTabs = [];

    /** @type {boolean} Whether an offscreen document is considered live */
    this.offscreenOpen = false;

    /** @type {string[]} Ops sent to the offscreen document */
    this.offscreenOps = [];

    /**
     * Per-tab reply to GET_VIDEO_STATE. Set a tab id to null to make it
     * unresponsive, mimicking a tab with no content script yet.
     * @type {Map<number, object|null>}
     */
    this.videoStates = new Map();

    /** Response the fake offscreen document gives to each op. */
    this.offscreenResponses = { success: true, openChannels: 0, sent: 1, samples: [] };

    this.runtime = this._buildRuntime();
    this.tabsApi = this._buildTabs();
    this.storage = { session: this._buildStorage() };
    this.offscreen = this._buildOffscreen();
  }

  /** Install as the global `chrome`. */
  install() {
    globalThis.chrome = {
      runtime: this.runtime,
      tabs: this.tabsApi,
      storage: this.storage,
      offscreen: this.offscreen,
    };
    return this;
  }

  /** Deliver a message to every registered onMessage listener. */
  emitMessage(message, sender = {}) {
    const responses = [];
    for (const listener of this.messageListeners) {
      listener(message, sender, (response) => responses.push(response));
    }
    return responses;
  }

  /** Messages sent to tabs with the given action. */
  tabMessagesOfAction(action) {
    return this.tabMessages.filter((entry) => entry.message.action === action);
  }

  /** Runtime messages with the given action. */
  runtimeMessagesOfAction(action) {
    return this.runtimeMessages.filter((message) => message.action === action);
  }

  reset() {
    this.runtimeMessages = [];
    this.tabMessages = [];
    this.offscreenOps = [];
  }

  _buildRuntime() {
    const self = this;
    return {
      id: 'test-extension-id',
      lastError: null,

      onMessage: {
        addListener(listener) {
          self.messageListeners.push(listener);
        },
        removeListener(listener) {
          self.messageListeners = self.messageListeners.filter((l) => l !== listener);
        },
      },

      onInstalled: { addListener() {} },

      getManifest: () => ({ version: '0.3.0' }),

      getURL: (path) => `chrome-extension://test-extension-id/${path}`,

      async getContexts() {
        return self.offscreenOpen ? [{ contextType: 'OFFSCREEN_DOCUMENT' }] : [];
      },

      async sendMessage(message) {
        self.runtimeMessages.push(message);

        // Stand in for the offscreen document's own listener.
        if (message.target === 'synctube-offscreen') {
          self.offscreenOps.push(message.op);
          return { ...self.offscreenResponses };
        }

        return undefined;
      },
    };
  }

  _buildTabs() {
    const self = this;
    return {
      async query() {
        return self.tabs;
      },

      async get(tabId) {
        const tab = self.tabs.find((t) => t.id === tabId);
        if (!tab) throw new Error(`No tab with id ${tabId}`);
        return tab;
      },

      async sendMessage(tabId, message) {
        self.tabMessages.push({ tabId, message });

        if (message.action === 'GET_VIDEO_STATE') {
          const state = self.videoStates.has(tabId)
            ? self.videoStates.get(tabId)
            : null;

          if (state === null) throw new Error('Receiving end does not exist');
          return { success: true, videoState: state };
        }

        return { success: true };
      },

      async create(options) {
        const tab = { id: 9000 + self.createdTabs.length, url: options.url };
        self.createdTabs.push(tab);
        self.tabs.push(tab);
        return tab;
      },

      async update(tabId, options) {
        self.updatedTabs.push({ tabId, ...options });
        const tab = self.tabs.find((t) => t.id === tabId);
        if (tab) tab.url = options.url;
        return tab;
      },
    };
  }

  _buildStorage() {
    const self = this;
    return {
      async get(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const key of list) {
          if (key in self.session) out[key] = self.session[key];
        }
        return out;
      },

      async set(items) {
        Object.assign(self.session, items);
      },
    };
  }

  _buildOffscreen() {
    const self = this;
    return {
      async createDocument() {
        if (self.offscreenOpen) {
          throw new Error('Only a single offscreen document may be created');
        }
        self.offscreenOpen = true;
      },
      async closeDocument() {
        self.offscreenOpen = false;
      },
    };
  }
}

/**
 * A transport double that records what was sent, for ConnectionManager tests.
 */
export class FakeTransport {
  constructor(name) {
    this.name = name;
    this.sent = [];
    this.connected = false;
    this.messageCallback = null;
  }

  async connect() {
    this.connected = true;
  }

  send(message) {
    this.sent.push(message);
  }

  onMessage(callback) {
    this.messageCallback = callback;
  }

  isConnected() {
    return this.connected;
  }

  async disconnect() {
    this.connected = false;
  }
}
