import test from 'node:test';
import assert from 'node:assert/strict';

import { ChromeStub } from './helpers/chrome-stub.js';
import { loadScripts } from './helpers/load-script.js';
import {
  FakeRTCPeerConnection,
  FakeRTCSessionDescription,
  FakeRTCIceCandidate,
} from './helpers/fake-webrtc.js';

const chromeStub = new ChromeStub().install();

const { ConnectionManager } = await import('../src/background/ConnectionManager.js');
const { EventBus } = await import('../src/background/EventBus.js');

/**
 * Regression tests for the race that kept every room on the WebSocket relay.
 *
 * The server sends ROOM_STATE and broadcasts JOIN the instant a socket
 * connects. When the socket was opened before the WebRTC host was initialised,
 * those messages drove syncPeers into an offscreen document that did not yet
 * know its own peer ID — where it could neither exclude itself from the room
 * list nor compute its offerer/answerer role.
 */

test('the WebRTC host is initialised before the socket can deliver anything', async () => {
  const order = [];

  const manager = new ConnectionManager(new EventBus());

  manager._rtcTransport.connect = async () => {
    order.push('rtc-connect-start');
    // Stands in for the ICE-server fetch, which can take a cold start.
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push('rtc-connect-done');
  };

  manager._wsTransport.connect = async () => {
    order.push('ws-connect');
  };

  await manager.connect('ABC123', 'peer_bbbbbbbb');

  assert.deepEqual(order, ['rtc-connect-start', 'rtc-connect-done', 'ws-connect']);
  assert.ok(
    order.indexOf('rtc-connect-done') < order.indexOf('ws-connect'),
    'the socket must not open until the WebRTC host knows its peer ID'
  );
});

test('the relay is the active transport from the very first message', async () => {
  const manager = new ConnectionManager(new EventBus());
  manager._rtcTransport.connect = async () => {};
  manager._wsTransport.connect = async () => {};

  await manager.connect('ABC123', 'peer_bbbbbbbb');

  // Nothing has proven the mesh works yet, so playback must go over the relay.
  assert.equal(manager.getActiveTransportName(), 'WebSocket');
});

// ---- Offscreen document behaviour without an identity ----------

function buildOffscreen() {
  FakeRTCPeerConnection.reset();

  const listeners = [];
  const outbound = [];

  loadScripts(['src/offscreen/offscreen.js'], {
    RTCPeerConnection: FakeRTCPeerConnection,
    RTCSessionDescription: FakeRTCSessionDescription,
    RTCIceCandidate: FakeRTCIceCandidate,
    chrome: {
      runtime: {
        onMessage: { addListener: (fn) => listeners.push(fn) },
        sendMessage: async (message) => { outbound.push(message); },
      },
    },
  });

  const call = (op) => new Promise((resolve) => {
    let settled = false;
    const respond = (response) => {
      if (settled) return;
      settled = true;
      resolve(response);
    };

    let kept = false;
    for (const listener of listeners) {
      if (listener({ target: 'synctube-offscreen', ...op }, {}, respond) === true) kept = true;
    }
    if (!kept) respond(undefined);
  });

  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

  return { call, settle, outbound };
}

test('SYNC_PEERS before INIT creates no connections at all', async () => {
  const rig = buildOffscreen();

  // This is exactly what the race delivered: a peer list, no identity.
  await rig.call({ op: 'SYNC_PEERS', peerIds: ['peer_aaaaaaaa', 'peer_bbbbbbbb'] });
  await rig.settle();

  assert.equal(
    FakeRTCPeerConnection.instances.length,
    0,
    'a peer with no identity cannot exclude itself, so it would dial itself'
  );
});

test('an offer before INIT is refused rather than answered with a guessed role', async () => {
  const rig = buildOffscreen();

  await rig.call({
    op: 'HANDLE_OFFER',
    peerId: 'peer_aaaaaaaa',
    sdp: { type: 'offer', sdp: 'remote' },
  });
  await rig.settle();

  const answers = rig.outbound.filter(
    (m) => m.event === 'SIGNALING' && m.signalType === 'SDP_ANSWER'
  );
  assert.deepEqual(answers, [], 'answering would fix a role computed against null');
});

test('after INIT the two peers take opposite roles', async () => {
  const lower = buildOffscreen();
  await lower.call({ op: 'INIT', roomId: 'ABC123', peerId: 'peer_aaaaaaaa' });
  await lower.call({ op: 'SYNC_PEERS', peerIds: ['peer_aaaaaaaa', 'peer_zzzzzzzz'] });
  await lower.settle();

  const higher = buildOffscreen();
  await higher.call({ op: 'INIT', roomId: 'ABC123', peerId: 'peer_zzzzzzzz' });
  await higher.call({ op: 'SYNC_PEERS', peerIds: ['peer_aaaaaaaa', 'peer_zzzzzzzz'] });
  await higher.settle();

  const offersFrom = (rig) => rig.outbound.filter(
    (m) => m.event === 'SIGNALING' && m.signalType === 'SDP_OFFER'
  ).length;

  // Exactly one offer across the pair. Two means glare, zero means deadlock.
  assert.equal(offersFrom(lower), 1, 'the lower ID must offer');
  assert.equal(offersFrom(higher), 0, 'the higher ID must wait');
});

test('a peer never dials itself once it has an identity', async () => {
  const rig = buildOffscreen();
  await rig.call({ op: 'INIT', roomId: 'ABC123', peerId: 'peer_bbbbbbbb' });

  await rig.call({ op: 'SYNC_PEERS', peerIds: ['peer_bbbbbbbb'] });
  await rig.settle();

  assert.equal(FakeRTCPeerConnection.instances.length, 0);
});

test('ICE arriving before its peer entry is held, not discarded', async () => {
  const rig = buildOffscreen();
  await rig.call({ op: 'INIT', roomId: 'ABC123', peerId: 'peer_zzzzzzzz' });

  // ICE gathering starts as soon as the offerer sets a local description, so
  // its candidates routinely overtake the SDP that creates this side's entry.
  await rig.call({ op: 'HANDLE_ICE', peerId: 'peer_aaaaaaaa', candidate: { candidate: 'early-1' } });
  await rig.call({ op: 'HANDLE_ICE', peerId: 'peer_aaaaaaaa', candidate: { candidate: 'early-2' } });

  await rig.call({
    op: 'HANDLE_OFFER',
    peerId: 'peer_aaaaaaaa',
    sdp: { type: 'offer', sdp: 'remote' },
  });
  await rig.settle();

  const pc = FakeRTCPeerConnection.instances[0];
  const added = pc.addedCandidates.map((c) => c.candidate);

  assert.deepEqual(
    added,
    ['early-1', 'early-2'],
    'discarded candidates are often the host pair that would have connected fastest'
  );
});

test('held candidates for a peer that never appears are bounded', async () => {
  const rig = buildOffscreen();
  await rig.call({ op: 'INIT', roomId: 'ABC123', peerId: 'peer_zzzzzzzz' });

  for (let i = 0; i < 200; i++) {
    await rig.call({
      op: 'HANDLE_ICE',
      peerId: 'peer_ghostghost',
      candidate: { candidate: `c${i}` },
    });
  }

  await rig.call({
    op: 'HANDLE_OFFER',
    peerId: 'peer_ghostghost',
    sdp: { type: 'offer', sdp: 'remote' },
  });
  await rig.settle();

  const pc = FakeRTCPeerConnection.instances[0];
  assert.ok(
    pc.addedCandidates.length <= 30,
    `buffer must stay bounded, got ${pc.addedCandidates.length}`
  );
});

test('a mesh that failed to form is retried, but not in a tight loop', async () => {
  const { ConnectionManager: CM } = await import('../src/background/ConnectionManager.js');
  const { EventBus: Bus } = await import('../src/background/EventBus.js');

  const manager = new CM(new Bus());
  const syncCalls = [];
  manager._rtcTransport.syncPeers = async (ids) => { syncCalls.push(ids); };
  manager._rtcTransport.getOpenChannelCount = () => 0;

  manager._roomId = 'ABC123';
  manager._peerId = 'peer_bbbbbbbb';
  manager._peers = new Set(['peer_aaaaaaaa', 'peer_bbbbbbbb']);

  // syncPeers is only issued when membership changes, so a stable room that
  // failed to build its mesh would otherwise never try again.
  manager._evaluateTransportState();
  assert.equal(syncCalls.length, 1, 'an absent mesh should be retried');

  manager._evaluateTransportState();
  manager._evaluateTransportState();
  assert.equal(syncCalls.length, 1, 'an unreachable peer must not cause a retry loop');
});

test('a healthy mesh is never needlessly re-synced', async () => {
  const { ConnectionManager: CM } = await import('../src/background/ConnectionManager.js');
  const { EventBus: Bus } = await import('../src/background/EventBus.js');

  const manager = new CM(new Bus());
  const syncCalls = [];
  manager._rtcTransport.syncPeers = async (ids) => { syncCalls.push(ids); };
  manager._rtcTransport.getOpenChannelCount = () => 1;

  manager._roomId = 'ABC123';
  manager._peerId = 'peer_bbbbbbbb';
  manager._peers = new Set(['peer_aaaaaaaa', 'peer_bbbbbbbb']);

  manager._evaluateTransportState();

  assert.deepEqual(syncCalls, [], 're-syncing would reset working connections');
  assert.equal(manager.getActiveTransportName(), 'WebRTC');
});

// ---- Liveness while the mesh carries playback -------------------

test('a re-INIT for the same session keeps working connections', async () => {
  const rig = buildOffscreen();
  await rig.call({ op: 'INIT', roomId: 'ABC123', peerId: 'peer_zzzzzzzz' });
  await rig.call({ op: 'SYNC_PEERS', peerIds: ['peer_aaaaaaaa', 'peer_zzzzzzzz'] });
  await rig.settle();

  const pc = FakeRTCPeerConnection.instances[0];
  assert.ok(pc, 'a connection should exist');

  // A WebSocket blip makes the worker re-run connect, which re-sends INIT. That
  // says nothing about the health of the peer connections, and renegotiating
  // takes seconds — long enough for the room to drop back to the relay.
  await rig.call({ op: 'INIT', roomId: 'ABC123', peerId: 'peer_zzzzzzzz' });

  assert.ok(!pc.closed, 'a healthy connection must survive a reconnect');
  const state = await rig.call({ op: 'GET_STATE' });
  assert.deepEqual(state.peerIds, ['peer_aaaaaaaa']);
});

test('a genuinely new session still starts clean', async () => {
  const rig = buildOffscreen();
  await rig.call({ op: 'INIT', roomId: 'ABC123', peerId: 'peer_zzzzzzzz' });
  await rig.call({ op: 'SYNC_PEERS', peerIds: ['peer_aaaaaaaa', 'peer_zzzzzzzz'] });
  await rig.settle();

  await rig.call({ op: 'INIT', roomId: 'XYZ789', peerId: 'peer_zzzzzzzz' });

  assert.ok(FakeRTCPeerConnection.instances[0].closed);
  const state = await rig.call({ op: 'GET_STATE' });
  assert.deepEqual(state.peerIds, []);
});

test('the keepalive takes the WebSocket even while the mesh is active', async () => {
  const { ConnectionManager: CM } = await import('../src/background/ConnectionManager.js');
  const { EventBus: Bus } = await import('../src/background/EventBus.js');

  const manager = new CM(new Bus());
  const viaRelay = [];
  const viaMesh = [];
  manager._wsTransport.send = (m) => viaRelay.push(m);
  manager._rtcTransport.send = (m) => viaMesh.push(m);
  manager._rtcTransport.isConnected = () => true;
  manager._activeTransport = manager._rtcTransport;

  manager.send({ type: 'PLAY' });
  manager.sendViaRelay({ type: 'KEEPALIVE' });

  // Playback belongs on the fast path; liveness has to be visible to the server.
  assert.deepEqual(viaMesh.map((m) => m.type), ['PLAY']);
  assert.deepEqual(viaRelay.map((m) => m.type), ['KEEPALIVE']);
});
