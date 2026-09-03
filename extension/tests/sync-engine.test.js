import test from 'node:test';
import assert from 'node:assert/strict';

import { ChromeStub } from './helpers/chrome-stub.js';

const chromeStub = new ChromeStub().install();

const { SyncEngine } = await import('../src/background/SyncEngine.js');
const { SyncState } = await import('../src/background/state/SyncStateMachine.js');

const HOST_ID = 'peer_aaaaaaaa';
const OTHER_ID = 'peer_cccccccc';

/**
 * A SyncEngine wired to a recording transport, with one responsive YouTube tab.
 *
 * @param {object} [options]
 * @param {boolean} [options.isHost]
 * @param {object|null} [options.videoState]
 */
async function buildEngine({ isHost = false, videoState = null } = {}) {
  chromeStub.reset();
  chromeStub.session = {};
  chromeStub.tabs = [{ id: 1, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }];
  chromeStub.videoStates = new Map([[1, videoState]]);

  const engine = new SyncEngine();
  await engine.init();

  engine._peerId = 'peer_bbbbbbbb';
  engine._roomId = 'ABC123';
  engine._isHost = isHost;
  engine._hostId = HOST_ID;

  const sent = [];
  engine.connectionManager.send = (message) => sent.push(message);
  engine.connectionManager.isConnected = () => true;
  engine.connectionManager.getActiveTransportName = () => 'WebSocket';
  engine.connectionManager.getRoomSize = () => 2;
  engine.connectionManager.getRttSamples = async () => [];

  return { engine, sent };
}

function envelope(type, payload, senderId = HOST_ID) {
  return { type, roomId: 'ABC123', senderId, lamportClock: 1, payload };
}

// ── PONG routing ────────────────────────────────────────────────

test('the host answers a PING addressed back to the asker', async () => {
  const { engine, sent } = await buildEngine({ isHost: true });

  engine.handleSyncMessage(envelope('PING', { originTimestamp: 1000 }, OTHER_ID));

  const pong = sent.find((m) => m.type === 'PONG');
  assert.ok(pong, 'host must answer a PING');
  assert.equal(
    pong.payload.targetPeerId,
    OTHER_ID,
    'the reply must name its recipient so the server can unicast it'
  );
  assert.equal(pong.payload.pingOriginTimestamp, 1000);
});

test('a non-host ignores PINGs entirely', async () => {
  const { engine, sent } = await buildEngine({ isHost: false });

  engine.handleSyncMessage(envelope('PING', { originTimestamp: 1000 }, OTHER_ID));

  assert.deepEqual(sent.filter((m) => m.type === 'PONG'), []);
});

test('a PONG addressed to another peer is discarded', async () => {
  const { engine } = await buildEngine();

  // Regression: PONG used to be broadcast, so this sample would be recorded.
  // It is `now - another peer's clock`, i.e. pure clock offset, and one such
  // sample skews compensation for the whole ten-sample window.
  engine.handleSyncMessage(envelope('PONG', {
    targetPeerId: OTHER_ID,
    pingOriginTimestamp: Date.now() - 250,
  }));

  assert.equal(engine.clockSync.sampleCount, 0);
});

test('a PONG addressed to us is recorded', async () => {
  const { engine } = await buildEngine();

  engine.handleSyncMessage(envelope('PONG', {
    targetPeerId: 'peer_bbbbbbbb',
    pingOriginTimestamp: Date.now() - 120,
  }));

  assert.equal(engine.clockSync.sampleCount, 1);
  assert.ok(engine.clockSync.rttMs >= 100, `got ${engine.clockSync.rttMs}ms`);
});

test('a PONG without a usable timestamp is discarded', async () => {
  const { engine } = await buildEngine();

  engine.handleSyncMessage(envelope('PONG', { targetPeerId: 'peer_bbbbbbbb' }));

  assert.equal(engine.clockSync.sampleCount, 0);
});

// ── Latency compensation on the command path ────────────────────

/** Build a command through the factory the way handleSyncMessage does. */
async function compensateVia(engine, type, payload) {
  const { CommandFactory } = await import('../src/background/commands/SyncCommand.js');
  const command = CommandFactory.fromWireMessage({ type, payload });
  return engine._compensate(type, command);
}

test('PLAY is advanced by the network delay', async () => {
  const { engine } = await buildEngine();
  engine.clockSync.recordRTT(300); // one-way estimate: 150ms

  const result = await compensateVia(engine, 'PLAY', {
    videoTime: 100,
    originTimestamp: Date.now(),
  });

  assert.ok(
    Math.abs(result.videoTime - 100.15) < 0.01,
    `expected ~100.15, got ${result.videoTime}`
  );
});

test('PAUSE is not advanced', async () => {
  const { engine } = await buildEngine();
  engine.clockSync.recordRTT(300);

  const result = await compensateVia(engine, 'PAUSE', {
    videoTime: 100,
    originTimestamp: Date.now(),
  });

  // A paused position is frozen; advancing it would push peers past the sender.
  assert.equal(result.videoTime, 100);
});

test('SEEK while playing is advanced', async () => {
  const { engine } = await buildEngine();
  engine.clockSync.recordRTT(400); // one-way estimate: 200ms

  const result = await compensateVia(engine, 'SEEK', {
    videoTime: 50,
    isPaused: false,
    originTimestamp: Date.now(),
  });

  assert.ok(Math.abs(result.videoTime - 50.2) < 0.01, `got ${result.videoTime}`);
});

test('SEEK while paused is not advanced', async () => {
  const { engine } = await buildEngine();
  engine.clockSync.recordRTT(400);

  const result = await compensateVia(engine, 'SEEK', {
    videoTime: 50,
    isPaused: true,
    originTimestamp: Date.now(),
  });

  assert.equal(result.videoTime, 50);
});

test('ROOM_STATE for a paused room is not advanced', async () => {
  const { engine } = await buildEngine();
  engine.clockSync.recordRTT(600);

  const result = await compensateVia(engine, 'ROOM_STATE', {
    videoTime: 30,
    isPaused: true,
    originTimestamp: Date.now(),
  });

  assert.equal(result.videoTime, 30);
});

test('DRIFT is not compensated twice', async () => {
  const { engine } = await buildEngine();
  engine.clockSync.recordRTT(500);

  // DRIFT targets are computed against the heartbeat that produced them, so
  // they arrive already compensated.
  const result = await compensateVia(engine, 'DRIFT', {
    videoTime: 42,
    isPaused: false,
    originTimestamp: Date.now(),
  });

  assert.equal(result.videoTime, 42);
});

test('a command with no position passes through untouched', async () => {
  const { engine } = await buildEngine();
  engine.clockSync.recordRTT(300);

  const result = await compensateVia(engine, 'PLAY', { originTimestamp: Date.now() });

  assert.ok(!('videoTime' in result) || result.videoTime === undefined);
});

// ── Host election ───────────────────────────────────────────────

test('HOST_CHANGE naming this peer promotes it', async () => {
  const { engine } = await buildEngine({
    isHost: false,
    videoState: {
      videoId: 'dQw4w9WgXcQ', videoTime: 10, isPaused: false, duration: 100, isReady: true,
    },
  });

  engine.handleSyncMessage(envelope('HOST_CHANGE', { newHostId: 'peer_bbbbbbbb' }, 'server'));

  assert.equal(engine.isHost, true);
});

test('HOST_CHANGE naming someone else demotes this peer', async () => {
  const { engine } = await buildEngine({ isHost: true });

  engine.handleSyncMessage(envelope('HOST_CHANGE', { newHostId: OTHER_ID }, 'server'));

  assert.equal(engine.isHost, false);
  assert.equal(engine._hostId, OTHER_ID);
});

test('a HOST_CHANGE confirming the status quo changes nothing', async () => {
  const { engine, sent } = await buildEngine({ isHost: true });
  engine._hostId = 'peer_bbbbbbbb';

  engine.handleSyncMessage(envelope('HOST_CHANGE', { newHostId: 'peer_bbbbbbbb' }, 'server'));

  assert.equal(engine.isHost, true);
  assert.deepEqual(sent.filter((m) => m.type === 'ROOM_STATE'), []);
});

test('ROOM_STATE carries the authoritative host', async () => {
  const { engine } = await buildEngine({ isHost: false });

  engine.handleSyncMessage(envelope('ROOM_STATE', {
    peers: [HOST_ID, 'peer_bbbbbbbb'],
    hostId: HOST_ID,
    videoTime: 5,
    isPaused: false,
  }, 'server'));

  assert.equal(engine._hostId, HOST_ID);
  assert.equal(engine.isHost, false);
});

// ── Drift correction ────────────────────────────────────────────

test('drift beyond tolerance produces a DRIFT correction', async () => {
  const { engine } = await buildEngine({
    isHost: false,
    videoState: {
      videoId: 'vid1', videoTime: 100, isPaused: false, duration: 500, isReady: true,
    },
  });

  const corrections = [];
  engine.eventBus.on('command:received', (payload) => corrections.push(payload));

  await engine._handleHeartbeat(envelope('HEARTBEAT', {
    videoId: 'vid1',
    videoTime: 105,
    isPaused: false,
    originTimestamp: Date.now(),
  }));

  assert.equal(corrections.length, 1);
  assert.equal(corrections[0].type, 'DRIFT');
  assert.ok(corrections[0].command.payload.videoTime >= 105);
});

test('drift within tolerance produces no correction', async () => {
  const { engine } = await buildEngine({
    isHost: false,
    videoState: {
      videoId: 'vid1', videoTime: 100, isPaused: false, duration: 500, isReady: true,
    },
  });

  const corrections = [];
  engine.eventBus.on('command:received', (payload) => corrections.push(payload));

  await engine._handleHeartbeat(envelope('HEARTBEAT', {
    videoId: 'vid1',
    videoTime: 100.1,
    isPaused: false,
    originTimestamp: Date.now(),
  }));

  assert.deepEqual(corrections, []);
});

test('a play/pause mismatch produces a correction even with no time drift', async () => {
  const { engine } = await buildEngine({
    isHost: false,
    videoState: {
      videoId: 'vid1', videoTime: 100, isPaused: false, duration: 500, isReady: true,
    },
  });

  const corrections = [];
  engine.eventBus.on('command:received', (payload) => corrections.push(payload));

  await engine._handleHeartbeat(envelope('HEARTBEAT', {
    videoId: 'vid1',
    videoTime: 100,
    isPaused: true,
    originTimestamp: Date.now(),
  }));

  assert.equal(corrections.length, 1);
  assert.equal(corrections[0].command.payload.isPaused, true);
});

test('a heartbeat for a different video is ignored', async () => {
  const { engine } = await buildEngine({
    isHost: false,
    videoState: {
      videoId: 'vid1', videoTime: 100, isPaused: false, duration: 500, isReady: true,
    },
  });

  const corrections = [];
  engine.eventBus.on('command:received', (payload) => corrections.push(payload));

  await engine._handleHeartbeat(envelope('HEARTBEAT', {
    videoId: 'a-completely-different-video',
    videoTime: 5,
    isPaused: false,
    originTimestamp: Date.now(),
  }));

  assert.deepEqual(corrections, []);
});

test('the host does not correct itself against its own heartbeat', async () => {
  const { engine } = await buildEngine({
    isHost: true,
    videoState: {
      videoId: 'vid1', videoTime: 100, isPaused: false, duration: 500, isReady: true,
    },
  });

  const corrections = [];
  engine.eventBus.on('command:received', (payload) => corrections.push(payload));

  await engine._handleHeartbeat(envelope('HEARTBEAT', {
    videoId: 'vid1', videoTime: 999, isPaused: false, originTimestamp: Date.now(),
  }));

  assert.deepEqual(corrections, []);
});

// ── Status reporting ────────────────────────────────────────────

test('status updates are broadcast under the key both UIs read', async () => {
  const { engine } = await buildEngine();

  engine._broadcastStatusUpdate();

  const updates = chromeStub.runtimeMessagesOfAction('UPDATE_STATUS');
  assert.equal(updates.length, 1);
  assert.ok(
    updates[0].payload,
    'popup.js and content-script.js both read message.payload; any other key drops every live update'
  );
  assert.equal(updates[0].payload.roomId, 'ABC123');
});

test('status reports the active transport and RTT', async () => {
  const { engine } = await buildEngine();
  engine.clockSync.recordRTT(180);

  const status = engine.getStatus();

  assert.equal(status.transport, 'WebSocket');
  assert.equal(status.rttMs, 180);
  assert.equal(status.peerCount, 2);
});

// ── Tab caching ─────────────────────────────────────────────────

test('the tab id is resolved once and reused', async () => {
  const { engine } = await buildEngine({
    videoState: {
      videoId: 'vid1', videoTime: 1, isPaused: true, duration: 10, isReady: true,
    },
  });

  let queryCount = 0;
  const realQuery = chrome.tabs.query;
  chrome.tabs.query = async (...args) => {
    queryCount++;
    return realQuery(...args);
  };

  await engine._getTabVideoState();
  await engine._getTabVideoState();
  await engine._getTabVideoState();

  chrome.tabs.query = realQuery;

  // chrome.tabs.query is an async IPC round trip; it used to run on every
  // inbound command and every heartbeat tick.
  assert.equal(queryCount, 1, `expected one query, got ${queryCount}`);
});

test('an unresponsive cached tab is re-resolved', async () => {
  const { engine } = await buildEngine({ videoState: null });

  chromeStub.tabs = [
    { id: 1, url: 'https://www.youtube.com/watch?v=a' },
    { id: 2, url: 'https://www.youtube.com/watch?v=b' },
  ];
  chromeStub.videoStates = new Map([
    [1, null], // no content script
    [2, { videoId: 'b', videoTime: 7, isPaused: false, duration: 60, isReady: true }],
  ]);
  engine._invalidateTabCache();

  const first = await engine._getTabVideoState();
  assert.equal(first.state, null, 'tab 1 answers nothing');

  // Tab 1 is dropped from the list; the next resolve should land on tab 2.
  chromeStub.tabs = [{ id: 2, url: 'https://www.youtube.com/watch?v=b' }];
  const second = await engine._getTabVideoState();

  assert.ok(second.state, 'must recover onto a responsive tab');
  assert.equal(second.state.videoId, 'b');
});

// ── State machine integration ───────────────────────────────────

test('a woken worker can reach SYNCING from DISCONNECTED via JOINING', async () => {
  const { engine } = await buildEngine();

  assert.equal(engine.stateMachine.state, SyncState.DISCONNECTED);

  // Regression: DISCONNECTED -> SYNCING is not a legal edge, so a reconnect
  // that skipped JOINING left the UI reading "Not connected" forever.
  engine._enterState(SyncState.JOINING);
  engine._enterState(SyncState.SYNCING);

  assert.equal(engine.stateMachine.state, SyncState.SYNCING);
});

test('an illegal transition is skipped rather than thrown', async () => {
  const { engine } = await buildEngine();

  // Transitions are driven by unordered network events, so an illegal one is a
  // race, not a bug — and throwing would abort the calling handler.
  assert.doesNotThrow(() => engine._enterState(SyncState.SYNCED));
  assert.equal(engine.stateMachine.state, SyncState.DISCONNECTED);
});

test('a dropped connection reports RECONNECTING', async () => {
  const { engine } = await buildEngine();
  engine._enterState(SyncState.JOINING);
  engine._enterState(SyncState.SYNCING);

  engine.eventBus.emit('connection:reconnecting');

  assert.equal(engine.stateMachine.state, SyncState.RECONNECTING);
});

test('switching transport discards stale RTT samples', async () => {
  const { engine } = await buildEngine();
  engine.clockSync.recordRTT(400);
  assert.ok(engine.clockSync.sampleCount > 0);

  // RTT over a direct P2P path bears no relation to RTT over the relay.
  engine.eventBus.emit('transport:changed', { transport: 'WebRTC' });

  assert.equal(engine.clockSync.sampleCount, 0);
});
