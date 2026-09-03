/**
 * Loader for the extension's non-module scripts.
 *
 * The content scripts and the offscreen document are plain scripts that attach
 * themselves to `window` or register a chrome.runtime listener, so they cannot
 * be imported. Running them in a `node:vm` context with stub globals lets the
 * real files be tested rather than a re-implementation of them.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(here, '..', '..');

/**
 * Run one or more extension scripts in a shared context.
 *
 * @param {string[]} relativePaths - paths relative to the extension root
 * @param {object} globals - globals seeded into the context
 * @returns {object} the context, after every script has run
 */
export function loadScripts(relativePaths, globals = {}) {
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    Math,
    JSON,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Set,
    Map,
    Error,
    TypeError,
    Promise,
    URL,
    isFinite,
    isNaN,
    parseFloat,
    parseInt,
    ...globals,
  });

  // Scripts written for a browser expect `window` to be the global object.
  if (!('window' in globals)) {
    context.window = context;
  }

  for (const relativePath of relativePaths) {
    const source = readFileSync(resolve(extensionRoot, relativePath), 'utf8');
    vm.runInContext(source, context, { filename: relativePath });
  }

  return context;
}

/**
 * A minimal stand-in for an HTMLVideoElement.
 *
 * Tracks the properties the adapter reads and writes, so playback-rate nudging
 * and seek behaviour can be asserted without a real media pipeline.
 */
export class FakeVideo {
  constructor({ currentTime = 0, duration = 600, paused = false } = {}) {
    this.currentTime = currentTime;
    this.duration = duration;
    this.paused = paused;
    this.playbackRate = 1;
    this.readyState = 4;
    this.ended = false;

    /** @type {{rate: number, at: number}[]} Every playbackRate assignment */
    this.rateHistory = [];

    /** @type {number[]} Every currentTime assignment */
    this.seekHistory = [];

    /** @type {Map<string, Function[]>} */
    this._listeners = new Map();

    this.classList = {
      _set: new Set(['html5-main-video']),
      contains: (cls) => this.classList._set.has(cls),
      add: (cls) => this.classList._set.add(cls),
    };

    // Record assignments without losing plain property semantics.
    let rate = 1;
    Object.defineProperty(this, 'playbackRate', {
      get: () => rate,
      set: (value) => {
        rate = value;
        this.rateHistory.push({ rate: value, at: Date.now() });
      },
    });

    let time = currentTime;
    Object.defineProperty(this, 'currentTime', {
      get: () => time,
      set: (value) => {
        time = value;
        this.seekHistory.push(value);
      },
    });
  }

  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(handler);
  }

  removeEventListener(type, handler) {
    const handlers = this._listeners.get(type) || [];
    this._listeners.set(type, handlers.filter((h) => h !== handler));
  }

  dispatch(type) {
    for (const handler of this._listeners.get(type) || []) handler({ type });
  }

  closest() {
    return null;
  }

  async play() {
    this.paused = false;
    this.dispatch('play');
  }

  pause() {
    this.paused = true;
    this.dispatch('pause');
  }
}
