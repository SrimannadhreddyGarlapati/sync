import test from 'node:test';
import assert from 'node:assert/strict';

import { loadScripts } from './helpers/load-script.js';
import {
  FakeRTCPeerConnection,
  FakeRTCSessionDescription,
  FakeRTCIceCandidate,
} from './helpers/fake-webrtc.js';

const LOCAL = 'peer_bbbbbbbb';
const LOWER = 'peer_aaaaaaaa';  // sorts before LOCAL, so LOWER offers
const HIGHER = 'peer_cccccccc'; // sorts after LOCAL, so LOCAL offers

/**
 * Load the offscreen document with a fake WebRTC stack, and return a driver
 * that sends it ops the way WebRTCTransport would.
 */
function buildOffscreen() {
  FakeRTCPeerConnection.reset();

  const listeners = [];
  const outbound = [];

  const context = loadScripts(['src/offscreen/offscreen.js'], {
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

  /**
   * Send an op and resolve with the response.
   *
   * A listener that returns true will call sendResponse asynchronously, so the
   * promise must stay pending until it does — resolving early would let the
   * test continue before the op had actually run.
   */
  const call = (op) => new Promise((resolve) => {
    let settled = false;
    const respond = (response) => {
      if (settled) return;
      settled = true;
      resolve(response);
    };

    let keptChannelOpen = false;
    for (const listener of listeners) {
      if (listener({ target: 'synctube-offscreen', ...op }, {}, respond) === true) {
        keptChannelOpen = true;
      }
    }

    if (!keptChannelOpen) respond(undefined);
  });

  /** Let queued microtasks and the negotiationneeded tick run. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

  return {
    context,
    outbound,
    listeners,
    call,
    settle,
    signalsOf: (type) => outbound.filter(
      (m) => m.event === 'SIGNALING' && m.signalType === type
    ),
    events: (event) => outbound.filter((m) => m.event === event),
    pcFor: (index) => FakeRTCPeerConnection.instances[index],
  };
}

async function initialized() {
  const rig = buildOffscreen();
  await rig.call({
    op: 'INIT',
    roomId: 'ABC123',
    peerId: LOCAL,
    iceServers: [{ urls: 'stun:example.test:3478' }],
  });
  return rig;
}

// ── Role selection ──────────────────────────────────────────────

test('the lower peer ID offers, so exactly one side does', async () => {
  const rig = await initialized();

  // Against a higher ID, this peer offers.
  await rig.call({ op: 'SYNC_PEERS', peerIds: [LOCAL, HIGHER] });
  await rig.settle();

  assert.equal(rig.signalsOf('SDP_OFFER').length, 1);
  assert.equal(rig.signalsOf('SDP_OFFER')[0].targetPeerId, HIGHER);
});

test('against a lower peer ID this peer waits rather than offering', async () => {
  const rig = await initialized();

  await rig.call({ op: 'SYNC_PEERS', peerIds: [LOCAL, LOWER] });
  await rig.settle();

  // Both sides deriving the role from the same two IDs is what prevents the
  // glare that a symmetric "everyone offers" scheme produces.
  assert.deepEqual(rig.signalsOf('SDP_OFFER'), []);
  assert.equal(FakeRTCPeerConnection.instances.length, 1, 'connection still created');
});

test('an offer from the lower peer is answered', async () => {
  const rig = await initialized();
  await rig.call({ op: 'SYNC_PEERS', peerIds: [LOCAL, LOWER] });
  await rig.settle();

  await rig.call({
    op: 'HANDLE_OFFER',
    peerId: LOWER,
    sdp: { type: 'offer', sdp: 'remote-offer' },
  });

  const answers = rig.signalsOf('SDP_ANSWER');
  assert.equal(answers.length, 1);
  assert.equal(answers[0].targetPeerId, LOWER);
  assert.equal(answers[0].body.sdp.type, 'answer');
});

test('the offerer creates the single data channel', async () => {
  const rig = await initialized();

  await rig.call({ op: 'SYNC_PEERS', peerIds: [LOCAL, HIGHER] });
  await rig.settle();

  const pc = rig.pcFor(0);
  assert.equal(pc.channels.length, 1);
  assert.equal(pc.channels[0].label, 'sync');
});

test('the data channel is fully reliable', async () => {
  const rig = await initialized();
  await rig.call({ op: 'SYNC_PEERS', peerIds: [LOCAL, HIGHER] });
  await rig.settle();

  const options = rig.pcFor(0).channels[0].options;

  // maxRetransmits would make the channel only partially reliable: a dropped
  // PLAY that never retransmits leaves that peer permanently out of sync.
  assert.equal(options.ordered, true);
  assert.ok(!('maxRetransmits' in options), 'must not cap retransmits');
  assert.ok(!('maxPacketLifeTime' in options), 'must not time packets out');
});

test('the answerer adopts the channel the offerer opened', async () => {
  const rig = await initialized();
  await rig.call({ op: 'SYNC_PEERS', peerIds: [LOCAL, LOWER] });
  await rig.settle();

  const pc = rig.pcFor(0);
  assert.equal(pc.channels.length, 0, 'answerer creates no channel of its own');

  const remoteChannel = pc.emitRemoteChannel();
  remoteChannel.open();

  const states = rig.events('CHANNEL_STATE');
  assert.ok(states.at(-1).openChannels >= 1);
});

// ── ICE handling ────────────────────────────────────────────────

test('candidates arriving before the remote description are queued, then drained', async () => {
  const rig = await initialized();
  await rig.call({ op: 'SYNC_PEERS', peerIds: [LOCAL, LOWER] });
  await rig.settle();

  const pc = rig.pcFor(0);

  // ICE routinely outruns SDP; adding these now would throw.
  await rig.call({ op: 'HANDLE_ICE', peerId: LOWER, candidate: { candidate: 'c1' } });
  await rig.call({ op: 'HANDLE_ICE', peerId: LOWER, candidate: { candidate: 'c2' } });
  assert.deepEqual(pc.addedCandidates, []);

  await rig.call({
    op: 'HANDLE_OFFER',
    peerId: LOWER,
    sdp: { type: 'offer', sdp: 'remote-offer' },
  });

  assert.equal(pc.addedCandidates.length, 2);
  assert.equal(pc.addedCandidates[0].candidate, 'c1');
});

test('candidates after the remote description are added immediately', async () => {
  const rig = await initialized();
  await rig.call({ op: 'SYNC_PEERS', peerIds: [LOCAL, LOWER] });
  await rig.settle();
  await rig.call({
    op: 'HANDLE_OFFER',
    peerId: LOWER,
    sdp: { type: 'offer', sdp: 'remote-offer' },
  });

  await rig.call({ op: 'HANDLE_ICE', peerId: LOWER, candidate: { candidate: 'late' } });

  assert.equal(rig.pcFor(0).addedCandidates.at(-1).candidate, 'late');
});

test('locally gathered candidates are signalled out', async () => {
  const rig = await initialized();
  await rig.call({ op: 'SYNC_PEERS', peerIds: [LOCAL, HIGHER] });
  await rig.settle();

  rig.pcFor(0).emitCandidate({ candidate: 'mine' });

  const ice = rig.signalsOf('ICE_CANDIDATE');
  assert.equal(ice.length, 1);
  assert.equal(ice[0].targetPeerId, HIGHER);
});

test('a candidate for an unknown peer is dropped without throwing', async () => {
  const rig = await initialized();

  const response = await rig.call({
    op: 'HANDLE_ICE',
    peerId: 'peer_zzzzzzzz',
    candidate: { candidate: 'orphan' },
  });

  assert.equal(response.success, true);
});

// ── Mesh reconciliation ─────────────────────────────────────────

test('SYNC_PEERS adds and removes to match the room', async () => {
  const rig = await initialized();

  await rig.call({ op: 'SYNC_PEERS', peerIds: [LOCAL, LOWER, HIGHER] });
  await rig.settle();
  assert.equal(FakeRTCPeerConnection.instances.length, 2);

  // LOWER left the room.
  await rig.call({ op: 'SYNC_PEERS', peerIds: [LOCAL, HIGHER] });
  await rig.settle();

  const state = await rig.call({ op: 'GET_STATE' });
  assert.deepEqual(state.peerIds, [HIGHER]);
});

test('SYNC_PEERS is idempotent', async () => {
  const rig = await initialized();

  await rig.call({ op: 'SYNC_PEERS', peerIds: [LOCAL, HIGHER] });
  await rig.settle();
  await rig.call({ op: 'SYNC_PEERS', peerIds: [LOCAL, HIGHER] });
  await rig.call({ op: 'SYNC_PEERS', peerIds: [LOCAL, HIGHER] });
  await rig.settle();

  // Re-offering to an established peer would reset a working connection.
  assert.equal(FakeRTCPeerConnection.instances.length, 1);
  assert.equal(rig.signalsOf('SDP_OFFER').length, 1);
});

test('this peer never connects to itself', async () => {
  const rig = await initialized();

  await rig.call({ op: 'SYNC_PEERS', peerIds: [LOCAL] });
  await rig.settle();

  assert.equal(FakeRTCPeerConnection.instances.length, 0);
});

test('INIT wipes existing connections, so a worker restart starts clean', async () => {
  const rig = await initialized();
  await rig.call({ op: 'SYNC_PEERS', peerIds: [LOCAL, HIGHER] });
  await rig.settle();
  assert.equal(FakeRTCPeerConnection.instances.length, 1);

  await rig.call({ op: 'INIT', roomId: 'XYZ789', peerId: LOCAL });

  const state = await rig.call({ op: 'GET_STATE' });
  assert.deepEqual(state.peerIds, []);
  assert.ok(rig.pcFor(0).closed, 'the old connection must be closed');
});

test('REMOVE_PEER closes that connection', async () => {
  const rig = await initialized();
  await rig.call({ op: 'SYNC_PEERS', peerIds: [LOCAL, HIGHER] });
  await rig.settle();

  await rig.call({ op: 'REMOVE_PEER', peerId: HIGHER });

  assert.ok(rig.pcFor(0).closed);
  const state = await rig.call({ op: 'GET_STATE' });
  assert.deepEqual(state.peerIds, []);
});

// ── Data path ───────────────────────────────────────────────────

test('SEND reaches only open channels', async () => {
  const rig = await initialized();
  await rig.call({ op: 'SYNC_PEERS', peerIds: [LOCAL, HIGHER] });
  await rig.settle();

  const channel = rig.pcFor(0).channels[0];

  const beforeOpen = await rig.call({ op: 'SEND', message: { type: 'PLAY' } });
  assert.equal(beforeOpen.sent, 0, 'a connecting channel must not be counted');

  channel.open();
  const afterOpen = await rig.call({ op: 'SEND', message: { type: 'PLAY' } });

  assert.equal(afterOpen.sent, 1);
  assert.deepEqual(JSON.parse(channel.sent[0]), { type: 'PLAY' });
});

test('an inbound channel message is forwarded to the worker', async () => {
  const rig = await initialized();
  await rig.call({ op: 'SYNC_PEERS', peerIds: [LOCAL, HIGHER] });
  await rig.settle();

  const channel = rig.pcFor(0).channels[0];
  channel.open();
  channel.receive(JSON.stringify({ type: 'SEEK', payload: { videoTime: 12 } }));

  const messages = rig.events('MESSAGE');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].message.type, 'SEEK');
  assert.equal(messages[0].fromPeerId, HIGHER);
});

test('an unparseable channel message is dropped, not forwarded', async () => {
  const rig = await initialized();
  await rig.call({ op: 'SYNC_PEERS', peerIds: [LOCAL, HIGHER] });
  await rig.settle();

  const channel = rig.pcFor(0).channels[0];
  channel.open();
  channel.receive('{not json');

  assert.deepEqual(rig.events('MESSAGE'), []);
});

test('a closed channel stops counting toward the mesh', async () => {
  const rig = await initialized();
  await rig.call({ op: 'SYNC_PEERS', peerIds: [LOCAL, HIGHER] });
  await rig.settle();

  const channel = rig.pcFor(0).channels[0];
  channel.open();
  assert.equal((await rig.call({ op: 'GET_STATE' })).openChannels, 1);

  channel.close();

  assert.equal((await rig.call({ op: 'GET_STATE' })).openChannels, 0);
});

// ── Failure handling ────────────────────────────────────────────

test("a transient 'disconnected' ICE state is not treated as failure", async () => {
  const rig = await initialized();
  await rig.call({ op: 'SYNC_PEERS', peerIds: [LOCAL, HIGHER] });
  await rig.settle();

  const pc = rig.pcFor(0);
  pc.setIceState('disconnected');

  // A brief blip on mobile recovers on its own; tearing down here would throw
  // away a path that was about to come back.
  assert.ok(!pc.closed);
  assert.equal(pc.iceRestarts, 0);
  assert.deepEqual((await rig.call({ op: 'GET_STATE' })).peerIds, [HIGHER]);
});

test("a genuine 'failed' ICE state restarts ICE on the offerer", async () => {
  const rig = await initialized();
  await rig.call({ op: 'SYNC_PEERS', peerIds: [LOCAL, HIGHER] });
  await rig.settle();

  rig.pcFor(0).setIceState('failed');

  assert.equal(rig.pcFor(0).iceRestarts, 1);
});

test('the answerer does not restart ICE; the offerer owns renegotiation', async () => {
  const rig = await initialized();
  await rig.call({ op: 'SYNC_PEERS', peerIds: [LOCAL, LOWER] });
  await rig.settle();

  rig.pcFor(0).setIceState('failed');

  assert.equal(rig.pcFor(0).iceRestarts, 0);
});

test('ICE servers from INIT reach the peer connection', async () => {
  const rig = await initialized();
  await rig.call({ op: 'SYNC_PEERS', peerIds: [LOCAL, HIGHER] });
  await rig.settle();

  assert.deepEqual(rig.pcFor(0).config.iceServers, [{ urls: 'stun:example.test:3478' }]);
  assert.equal(rig.pcFor(0).config.bundlePolicy, 'max-bundle');
});

test('GET_RTT reports the succeeded candidate pair', async () => {
  const rig = await initialized();
  await rig.call({ op: 'SYNC_PEERS', peerIds: [LOCAL, HIGHER] });
  await rig.settle();
  rig.pcFor(0).channels[0].open();

  const { samples } = await rig.call({ op: 'GET_RTT' });

  assert.equal(samples.length, 1);
  assert.equal(samples[0].peerId, HIGHER);
  assert.ok(Math.abs(samples[0].rttMs - 42) < 0.001, `got ${samples[0].rttMs}`);
});

test('messages for other targets are left to their own listeners', async () => {
  const rig = await initialized();
  const listener = rig.listeners[0];

  let responded = false;
  const kept = listener(
    { target: 'synctube-worker', event: 'CHANNEL_STATE' },
    {},
    () => { responded = true; }
  );

  // Returning true here would hold the message channel open and racing
  // sendResponse would clobber the real listener's reply.
  assert.equal(kept, false);
  assert.equal(responded, false);

  const bare = listener({ action: 'GET_STATUS' }, {}, () => { responded = true; });
  assert.equal(bare, false);
  assert.equal(responded, false);
});

test('an unknown op is reported rather than silently ignored', async () => {
  const rig = await initialized();

  const response = await rig.call({ op: 'NOT_A_REAL_OP' });

  assert.equal(response.success, false);
  assert.match(response.error, /Unknown op/);
});
