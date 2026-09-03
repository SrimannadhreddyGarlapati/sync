import test from 'node:test';
import assert from 'node:assert/strict';

import { ChromeStub } from './helpers/chrome-stub.js';

const chromeStub = new ChromeStub().install();

const { WebRTCTransport } = await import('../src/background/transports/WebRTCTransport.js');

/**
 * A transport with the offscreen bus and the ICE endpoint both stubbed.
 *
 * @param {object} [options]
 * @param {boolean} [options.failFirstCreate] - make the first createDocument reject
 * @param {boolean} [options.failIceFetch]
 */
function buildTransport({ failFirstCreate = false, failIceFetch = false } = {}) {
  chromeStub.reset();
  chromeStub.offscreenOpen = false;

  const ops = [];
  chromeStub.runtime.sendMessage = async (message) => {
    if (message.target === 'synctube-offscreen') {
      ops.push(message);
      return { success: true, openChannels: 0, sent: 1, samples: [] };
    }
    return undefined;
  };

  let createCalls = 0;
  chromeStub.offscreen.createDocument = async () => {
    createCalls++;
    if (failFirstCreate && createCalls === 1) {
      throw new Error('Transient failure creating offscreen document');
    }
    chromeStub.offscreenOpen = true;
  };

  globalThis.fetch = async () => {
    if (failIceFetch) throw new Error('network down');
    return {
      ok: true,
      json: async () => ({
        iceServers: [
          { urls: 'stun:stun.example.test:3478' },
          { urls: 'turn:turn.example.test:3478', username: 'u', credential: 'c' },
        ],
        turn: true,
      }),
    };
  };

  return { transport: new WebRTCTransport(), ops, createCalls: () => createCalls };
}

const opNames = (ops) => ops.map((o) => o.op);

test('connect fetches ICE servers and initializes the offscreen document', async () => {
  const { transport, ops } = buildTransport();

  await transport.connect('ABC123', 'peer_bbbbbbbb');

  const init = ops.find((o) => o.op === 'INIT');
  assert.ok(init, 'INIT must be sent');
  assert.equal(init.peerId, 'peer_bbbbbbbb');
  assert.equal(init.roomId, 'ABC123');
  assert.equal(init.iceServers.length, 2);
  assert.ok(
    init.iceServers.some((s) => String(s.urls).startsWith('turn:')),
    'TURN servers must reach the peer connection'
  );
});

test('INIT precedes any op that depends on it', async () => {
  const { transport, ops } = buildTransport();

  await transport.connect('ABC123', 'peer_bbbbbbbb');
  await transport.syncPeers(['peer_bbbbbbbb', 'peer_cccccccc']);

  const names = opNames(ops);
  assert.ok(names.indexOf('INIT') < names.indexOf('SYNC_PEERS'));
});

test('a failed document creation still yields an initialized document later', async () => {
  const { transport, ops } = buildTransport({ failFirstCreate: true });

  // The first attempt fails; the session must survive on the relay.
  await transport.connect('ABC123', 'peer_bbbbbbbb');
  assert.deepEqual(opNames(ops), [], 'nothing could be delivered yet');

  // A later op retries creation, and INIT must ride along ahead of it.
  await transport.syncPeers(['peer_bbbbbbbb', 'peer_cccccccc']);

  const names = opNames(ops);
  assert.deepEqual(names, ['INIT', 'SYNC_PEERS']);
  assert.equal(ops[0].peerId, 'peer_bbbbbbbb', 'the peer ID must not be lost');
});

test('INIT is sent exactly once per connect', async () => {
  const { transport, ops } = buildTransport();

  await transport.connect('ABC123', 'peer_bbbbbbbb');
  await transport.syncPeers(['peer_bbbbbbbb']);
  await transport.syncPeers(['peer_bbbbbbbb']);
  await transport.removePeer('peer_cccccccc');

  assert.equal(opNames(ops).filter((n) => n === 'INIT').length, 1);
});

test('a failed ICE fetch degrades to STUN rather than aborting', async () => {
  const { transport, ops } = buildTransport({ failIceFetch: true });

  await transport.connect('ABC123', 'peer_bbbbbbbb');

  const init = ops.find((o) => o.op === 'INIT');
  assert.ok(init);
  assert.ok(init.iceServers.length >= 1);
  assert.ok(
    init.iceServers.every((s) => String(s.urls).startsWith('stun:')),
    'fallback must be STUN-only'
  );
});

test('ICE servers are cached across a rejoin', async () => {
  const { transport } = buildTransport();

  let fetchCount = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    fetchCount++;
    return realFetch(...args);
  };

  await transport.connect('ABC123', 'peer_bbbbbbbb');
  await transport.connect('XYZ789', 'peer_bbbbbbbb');

  assert.equal(fetchCount, 1, 'credentials are valid for an hour; refetching is waste');
});

test('signaling events from the offscreen document become wire messages', async () => {
  const { transport } = buildTransport();
  await transport.connect('ABC123', 'peer_bbbbbbbb');

  const signalled = [];
  transport.onSignaling((message) => signalled.push(message));

  chromeStub.emitMessage({
    target: 'synctube-worker',
    event: 'SIGNALING',
    signalType: 'SDP_OFFER',
    targetPeerId: 'peer_cccccccc',
    body: { sdp: { type: 'offer', sdp: 'x' } },
  });

  assert.equal(signalled.length, 1);
  assert.equal(signalled[0].type, 'SDP_OFFER');
  assert.equal(signalled[0].roomId, 'ABC123');
  assert.equal(signalled[0].senderId, 'peer_bbbbbbbb');
  assert.equal(signalled[0].payload.targetPeerId, 'peer_cccccccc');
  assert.equal(signalled[0].payload.sdp.type, 'offer');
});

test('channel-state events drive the connectivity callback', async () => {
  const { transport } = buildTransport();
  await transport.connect('ABC123', 'peer_bbbbbbbb');

  let notifications = 0;
  transport.onChannelStateChange(() => notifications++);

  chromeStub.emitMessage({ target: 'synctube-worker', event: 'CHANNEL_STATE', openChannels: 2 });
  assert.equal(transport.getOpenChannelCount(), 2);
  assert.equal(transport.isConnected(), true);
  assert.equal(notifications, 1);

  // An unchanged count is not a state change.
  chromeStub.emitMessage({ target: 'synctube-worker', event: 'CHANNEL_STATE', openChannels: 2 });
  assert.equal(notifications, 1);

  chromeStub.emitMessage({ target: 'synctube-worker', event: 'CHANNEL_STATE', openChannels: 0 });
  assert.equal(transport.isConnected(), false);
  assert.equal(notifications, 2);
});

test('inbound channel messages reach the application callback', async () => {
  const { transport } = buildTransport();
  await transport.connect('ABC123', 'peer_bbbbbbbb');

  const received = [];
  transport.onMessage((message) => received.push(message));

  chromeStub.emitMessage({
    target: 'synctube-worker',
    event: 'MESSAGE',
    message: { type: 'PLAY', payload: { videoTime: 5 } },
    fromPeerId: 'peer_cccccccc',
  });

  assert.equal(received.length, 1);
  assert.equal(received[0].type, 'PLAY');
});

test('messages for other targets are ignored', async () => {
  const { transport } = buildTransport();
  await transport.connect('ABC123', 'peer_bbbbbbbb');

  const received = [];
  transport.onMessage((message) => received.push(message));

  chromeStub.emitMessage({ action: 'GET_STATUS' });
  chromeStub.emitMessage({ target: 'synctube-offscreen', op: 'SEND' });

  assert.deepEqual(received, []);
});

test('disconnect tears down and closes the document', async () => {
  const { transport, ops } = buildTransport();
  await transport.connect('ABC123', 'peer_bbbbbbbb');

  await transport.disconnect();

  assert.ok(opNames(ops).includes('TEARDOWN'));
  assert.equal(chromeStub.offscreenOpen, false);
  assert.equal(transport.isConnected(), false);
});
