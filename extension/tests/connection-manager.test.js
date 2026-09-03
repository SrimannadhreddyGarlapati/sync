import test from 'node:test';
import assert from 'node:assert/strict';

import { ChromeStub } from './helpers/chrome-stub.js';

const chromeStub = new ChromeStub().install();

const { ConnectionManager } = await import('../src/background/ConnectionManager.js');
const { EventBus } = await import('../src/background/EventBus.js');

/**
 * A ConnectionManager with both transports replaced by controllable doubles,
 * so transport selection can be driven without real sockets or peer connections.
 */
function buildManager() {
  const bus = new EventBus();
  const manager = new ConnectionManager(bus);

  const events = [];
  bus.on('transport:changed', (payload) => events.push(payload.transport));

  const delivered = [];
  manager.onMessage((message) => delivered.push(message));

  const ws = manager._wsTransport;
  const rtc = manager._rtcTransport;

  // Replace the real send paths with recorders.
  ws.sent = [];
  ws.send = (message) => ws.sent.push(message);
  ws.isConnected = () => true;

  rtc.sent = [];
  rtc.send = (message) => rtc.sent.push(message);
  rtc.syncedPeers = [];
  rtc.syncPeers = async (peerIds) => { rtc.syncedPeers.push(peerIds); };
  rtc.removedPeers = [];
  rtc.removePeer = async (peerId) => { rtc.removedPeers.push(peerId); };
  rtc.handledOffers = [];
  rtc.handleOffer = async (from, sdp) => { rtc.handledOffers.push({ from, sdp }); };
  rtc.handledAnswers = [];
  rtc.handleAnswer = async (from, sdp) => { rtc.handledAnswers.push({ from, sdp }); };
  rtc.handledIce = [];
  rtc.handleIceCandidate = async (from, candidate) => { rtc.handledIce.push({ from, candidate }); };

  // Channel count is the signal that decides whether the mesh is usable.
  rtc._openChannels = 0;
  rtc.getOpenChannelCount = () => rtc._openChannels;
  rtc.isConnected = () => rtc._openChannels > 0;

  manager._roomId = 'ABC123';
  manager._peerId = 'peer_bbbbbbbb';
  manager._peers = new Set(['peer_bbbbbbbb']);
  manager._activeTransport = ws;

  return { manager, ws, rtc, events, delivered };
}

function roomState(peers) {
  return {
    type: 'ROOM_STATE',
    senderId: 'server',
    lamportClock: 0,
    payload: { peers, hostId: peers[0] },
  };
}

test('ROOM_STATE adopts the server peer list wholesale', () => {
  const { manager, rtc } = buildManager();

  manager._handleWebSocketMessage(roomState(['peer_aaaaaaaa', 'peer_bbbbbbbb']));

  assert.equal(manager.getRoomSize(), 2);
  assert.deepEqual(rtc.syncedPeers.at(-1).sort(), ['peer_aaaaaaaa', 'peer_bbbbbbbb']);
});

test('a repeated JOIN for the same peer does not inflate room size', () => {
  const { manager } = buildManager();

  const join = {
    type: 'JOIN',
    senderId: 'peer_aaaaaaaa',
    lamportClock: 0,
    payload: { peerId: 'peer_aaaaaaaa' },
  };

  manager._handleWebSocketMessage(join);
  manager._handleWebSocketMessage(join);
  manager._handleWebSocketMessage(join);

  // Tracking identities rather than a running count makes this idempotent;
  // the old counter drifted permanently upward on any duplicate.
  assert.equal(manager.getRoomSize(), 2);
});

test('LEAVE for an unknown peer does not shrink room size', () => {
  const { manager } = buildManager();
  manager._handleWebSocketMessage(roomState(['peer_aaaaaaaa', 'peer_bbbbbbbb']));

  manager._handleWebSocketMessage({
    type: 'LEAVE',
    senderId: 'peer_zzzzzzzz',
    lamportClock: 0,
    payload: { peerId: 'peer_zzzzzzzz' },
  });

  assert.equal(manager.getRoomSize(), 2);
});

test('LEAVE tears down that peer connection', () => {
  const { manager, rtc } = buildManager();
  manager._handleWebSocketMessage(roomState(['peer_aaaaaaaa', 'peer_bbbbbbbb']));

  manager._handleWebSocketMessage({
    type: 'LEAVE',
    senderId: 'peer_aaaaaaaa',
    lamportClock: 0,
    payload: { peerId: 'peer_aaaaaaaa' },
  });

  assert.equal(manager.getRoomSize(), 1);
  assert.deepEqual(rtc.removedPeers, ['peer_aaaaaaaa']);
});

test('the mesh is adopted only once every expected channel is open', () => {
  const { manager, rtc, events } = buildManager();
  manager._handleWebSocketMessage(roomState(['peer_aaaaaaaa', 'peer_bbbbbbbb', 'peer_cccccccc']));

  // Two other peers means two channels are required.
  rtc._openChannels = 1;
  manager._evaluateTransportState();
  assert.equal(manager.getActiveTransportName(), 'WebSocket');
  assert.deepEqual(events, []);

  rtc._openChannels = 2;
  manager._evaluateTransportState();
  assert.equal(manager.getActiveTransportName(), 'WebRTC');
  assert.deepEqual(events, ['WebRTC']);
});

test('a partial mesh is abandoned rather than left half-connected', () => {
  const { manager, rtc, events } = buildManager();
  manager._handleWebSocketMessage(roomState(['peer_aaaaaaaa', 'peer_bbbbbbbb', 'peer_cccccccc']));

  rtc._openChannels = 2;
  manager._evaluateTransportState();
  assert.equal(manager.getActiveTransportName(), 'WebRTC');

  // One peer drops out of the mesh. Delivering to some peers but not others is
  // worse than routing everyone through the relay.
  rtc._openChannels = 1;
  manager._evaluateTransportState();

  assert.equal(manager.getActiveTransportName(), 'WebSocket');
  assert.deepEqual(events, ['WebRTC', 'WebSocket']);
});

test('a room above the P2P threshold never adopts the mesh', () => {
  const { manager, rtc } = buildManager();

  const peers = [
    'peer_aaaaaaaa', 'peer_bbbbbbbb', 'peer_cccccccc',
    'peer_dddddddd', 'peer_eeeeeeee', 'peer_ffffffff',
  ];
  manager._handleWebSocketMessage(roomState(peers));

  // A 6-peer mesh means 5 uploads of every command from every client.
  assert.deepEqual(rtc.syncedPeers.at(-1), [], 'mesh must be torn down');

  rtc._openChannels = 5;
  manager._evaluateTransportState();

  assert.equal(manager.getActiveTransportName(), 'WebSocket');
});

test('a solo room stays on the relay', () => {
  const { manager, rtc } = buildManager();
  manager._handleWebSocketMessage(roomState(['peer_bbbbbbbb']));

  rtc._openChannels = 0;
  manager._evaluateTransportState();

  assert.equal(manager.getActiveTransportName(), 'WebSocket');
});

test('signaling messages are consumed, never handed to the application', () => {
  const { manager, rtc, delivered } = buildManager();

  manager._handleWebSocketMessage({
    type: 'SDP_OFFER',
    senderId: 'peer_aaaaaaaa',
    payload: { sdp: { type: 'offer' } },
  });
  manager._handleWebSocketMessage({
    type: 'SDP_ANSWER',
    senderId: 'peer_aaaaaaaa',
    payload: { sdp: { type: 'answer' } },
  });
  manager._handleWebSocketMessage({
    type: 'ICE_CANDIDATE',
    senderId: 'peer_aaaaaaaa',
    payload: { candidate: { candidate: 'x' } },
  });

  assert.equal(rtc.handledOffers.length, 1);
  assert.equal(rtc.handledAnswers.length, 1);
  assert.equal(rtc.handledIce.length, 1);
  assert.deepEqual(delivered, [], 'signaling is transport plumbing, not application data');
});

test('playback commands arriving over the relay are ignored while the mesh is active', () => {
  const { manager, rtc, delivered } = buildManager();
  manager._handleWebSocketMessage(roomState(['peer_aaaaaaaa', 'peer_bbbbbbbb']));

  rtc._openChannels = 1;
  manager._evaluateTransportState();
  assert.equal(manager.getActiveTransportName(), 'WebRTC');

  manager._handleWebSocketMessage({
    type: 'PLAY',
    senderId: 'peer_aaaaaaaa',
    payload: { videoTime: 10 },
  });

  // Applying the same PLAY from both paths would seek twice.
  assert.deepEqual(delivered.filter((m) => m.type === 'PLAY'), []);
});

test('structural messages are delivered even while the mesh is active', () => {
  const { manager, rtc, delivered } = buildManager();
  manager._handleWebSocketMessage(roomState(['peer_aaaaaaaa', 'peer_bbbbbbbb']));

  rtc._openChannels = 1;
  manager._evaluateTransportState();

  manager._handleWebSocketMessage({
    type: 'HOST_CHANGE',
    senderId: 'server',
    payload: { newHostId: 'peer_bbbbbbbb' },
  });

  // Host election is relayed by the server and has no P2P equivalent, so it
  // must pass through regardless of which transport carries playback.
  assert.equal(delivered.filter((m) => m.type === 'HOST_CHANGE').length, 1);
});

test('send falls back to the relay if the mesh dropped since the last evaluation', () => {
  const { manager, ws, rtc } = buildManager();
  manager._handleWebSocketMessage(roomState(['peer_aaaaaaaa', 'peer_bbbbbbbb']));

  rtc._openChannels = 1;
  manager._evaluateTransportState();
  assert.equal(manager.getActiveTransportName(), 'WebRTC');

  // Channels die between evaluations; the command must not be lost.
  rtc._openChannels = 0;
  manager.send({ type: 'PAUSE', payload: {} });

  assert.equal(rtc.sent.length, 0);
  assert.equal(ws.sent.length, 1);
});

test('send uses the mesh while it is healthy', () => {
  const { manager, ws, rtc } = buildManager();
  manager._handleWebSocketMessage(roomState(['peer_aaaaaaaa', 'peer_bbbbbbbb']));

  rtc._openChannels = 1;
  manager._evaluateTransportState();
  manager.send({ type: 'PLAY', payload: {} });

  assert.equal(rtc.sent.length, 1);
  assert.equal(ws.sent.length, 0);
});

test('WebRTC messages always reach the application', () => {
  const { manager, delivered } = buildManager();

  manager._handleWebRTCMessage({ type: 'SEEK', senderId: 'peer_aaaaaaaa', payload: { videoTime: 5 } });

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].type, 'SEEK');
});
