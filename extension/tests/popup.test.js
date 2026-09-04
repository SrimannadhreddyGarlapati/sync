import test from 'node:test';
import assert from 'node:assert/strict';

import { loadScripts } from './helpers/load-script.js';

/**
 * A DOM stub covering only what popup.js touches.
 *
 * popup.js is an IIFE with no exports, so it is driven the way the real popup
 * is: by what GET_STATUS returns and by firing its poll timer. That exercises
 * the actual render path rather than a function pulled out of it.
 */
function buildDom() {
  const ids = [
    'statusDot', 'statusText', 'viewDisconnected', 'viewConnected',
    'btnCreate', 'btnJoin', 'inputRoomCode', 'errorMsg', 'roomCode',
    'peerCount', 'btnForceSync', 'btnLeave', 'transportChip', 'latencyChip',
    'version',
  ];

  const elements = {};
  for (const id of ids) {
    const el = {
      id,
      textContent: '',
      value: '',
      title: '',
      style: {},
      className: '',
      disabled: false,
      _classes: new Set(),
      _listeners: {},
      addEventListener(type, handler) { this._listeners[type] = handler; },
    };
    el.classList = {
      add: (...names) => names.forEach((n) => el._classes.add(n)),
      remove: (...names) => names.forEach((n) => el._classes.delete(n)),
      contains: (name) => el._classes.has(name),
    };
    elements[id] = el;
  }

  return { elements, document: { getElementById: (id) => elements[id] || null } };
}

/** Let the popup's promise chain settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

/**
 * Load popup.js and return handles for driving it.
 * @param {object} initialStatus - what the first GET_STATUS resolves to
 */
async function loadPopup(initialStatus = { success: true, state: 'DISCONNECTED' }) {
  const dom = buildDom();
  const sent = [];
  const timers = [];

  // Mutable so a test can change what the next poll observes.
  const box = { status: initialStatus };

  loadScripts(['src/popup/popup.js'], {
    document: dom.document,
    window: { addEventListener() {} },
    chrome: {
      runtime: {
        lastError: null,
        getManifest: () => ({ version: '0.3.0' }),
        sendMessage: (message, callback) => {
          sent.push(message);
          if (callback) callback(box.status);
        },
        onMessage: { addListener() {} },
      },
    },
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearInterval: () => {},
  });

  await settle();

  /** Re-render with a new status, the way the 2s poll does. */
  const poll = async (status) => {
    if (status) box.status = status;
    timers[0].fn();
    await settle();
  };

  return { dom, sent, timers, poll, box };
}

const inRoom = (extra = {}) => ({
  success: true,
  roomId: 'F6SCK6',
  state: 'SYNCED',
  isHost: false,
  peerCount: 2,
  transport: 'WebSocket',
  rttMs: 197,
  ...extra,
});

test('the version is read from the manifest, not hardcoded', async () => {
  const { dom } = await loadPopup();

  // A hardcoded version goes stale and makes a freshly reloaded build look
  // like the previous one, which is misleading while debugging.
  assert.equal(dom.elements.version.textContent, 'v0.3.0');
});

test('status is polled while the popup is open', async () => {
  const { timers } = await loadPopup();

  // RTT and transport change with no state transition to announce them.
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 2000);
});

test('a re-render while disconnected does not wipe a half-typed code', async () => {
  const { dom, poll } = await loadPopup();
  const input = dom.elements.inputRoomCode;

  input.value = 'F6S'; // user is mid-way through typing

  await poll();
  await poll();
  await poll();

  assert.equal(
    input.value,
    'F6S',
    'the poll used to clear the field every 2s, so only a fast paste survived'
  );
});

test('leaving a room does clear the code', async () => {
  const { dom, poll } = await loadPopup();

  await poll(inRoom());
  dom.elements.inputRoomCode.value = 'leftover';

  await poll({ success: true, roomId: null, state: 'DISCONNECTED' });

  assert.equal(dom.elements.inputRoomCode.value, '');
});

test('the transport chip distinguishes P2P from relay', async () => {
  const { dom, poll } = await loadPopup();
  const chip = dom.elements.transportChip;

  await poll(inRoom({ transport: 'WebSocket', rttMs: 197 }));
  assert.match(chip.textContent, /Relay/);
  assert.ok(chip.classList.contains('relay'));

  await poll(inRoom({ transport: 'WebRTC', rttMs: 12 }));
  assert.match(chip.textContent, /P2P/);
  assert.ok(chip.classList.contains('p2p'));
  assert.ok(!chip.classList.contains('relay'), 'the stale class must be removed');
});

test('latency reads as measuring until a sample exists', async () => {
  const { dom, poll } = await loadPopup();

  await poll(inRoom({ rttMs: 0, state: 'SYNCING' }));
  assert.match(dom.elements.latencyChip.textContent, /measuring/);

  await poll(inRoom({ rttMs: 42 }));
  assert.equal(dom.elements.latencyChip.textContent, '42 ms RTT');
});

test('the room shows how many others are present', async () => {
  const { dom, poll } = await loadPopup();

  await poll(inRoom({ isHost: true, peerCount: 1 }));
  assert.match(dom.elements.peerCount.textContent, /alone/);

  await poll(inRoom({ isHost: true, peerCount: 2 }));
  assert.match(dom.elements.peerCount.textContent, /1 other\b/);

  await poll(inRoom({ isHost: false, peerCount: 4 }));
  assert.match(dom.elements.peerCount.textContent, /3 others/);
});

test('the connected view replaces the join view once in a room', async () => {
  const { dom, poll } = await loadPopup();

  await poll(inRoom());

  assert.ok(dom.elements.viewDisconnected.classList.contains('hidden'));
  assert.ok(!dom.elements.viewConnected.classList.contains('hidden'));
  assert.equal(dom.elements.roomCode.textContent, 'F6SCK6');
});

test('the latency tooltip says what the number actually covers', async () => {
  const { dom, poll } = await loadPopup();

  await poll(inRoom({ transport: 'WebSocket', rttMs: 196 }));
  const relay = dom.elements.latencyChip.title;

  // On the relay this is a four-leg loop, so it reads roughly twice as large
  // as a plain ping to the server and invites a false "something is broken".
  assert.match(relay, /server/);
  assert.match(relay, /98 ms/, 'should name the one-way figure compensation uses');

  await poll(inRoom({ transport: 'WebRTC', rttMs: 12 }));
  const direct = dom.elements.latencyChip.title;

  assert.match(direct, /[Dd]irect/);
  assert.ok(!/server/.test(direct), 'a P2P round trip does not touch the server');
});

test('the transport chip explains itself on hover', async () => {
  const { dom, poll } = await loadPopup();

  await poll(inRoom({ transport: 'WebSocket' }));
  assert.match(dom.elements.transportChip.title, /relayed through the server/);

  await poll(inRoom({ transport: 'WebRTC' }));
  assert.match(dom.elements.transportChip.title, /directly between peers/);
});
