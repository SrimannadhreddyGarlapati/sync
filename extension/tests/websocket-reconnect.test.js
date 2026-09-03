import test from 'node:test';
import assert from 'node:assert/strict';

import { ChromeStub } from './helpers/chrome-stub.js';

new ChromeStub().install();

/**
 * A WebSocket double whose lifecycle the test drives by hand.
 */
class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    this.closedWith = null;

    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;

    FakeWebSocket.instances.push(this);
  }

  send(data) {
    this.sent.push(data);
  }

  close(code, reason) {
    this.closedWith = { code, reason };
  }

  /** Complete the handshake. */
  open() {
    this.readyState = FakeWebSocket.OPEN;
    if (this.onopen) this.onopen();
  }

  /** Drop the connection as the network would. */
  drop(code = 1006) {
    this.readyState = 3;
    if (this.onclose) this.onclose({ code });
  }
}

globalThis.WebSocket = FakeWebSocket;

const { WebSocketTransport } = await import('../src/background/transports/WebSocketTransport.js');

function freshTransport() {
  FakeWebSocket.instances = [];
  return new WebSocketTransport();
}

const latest = () => FakeWebSocket.instances.at(-1);

/** Yield to the event loop so pending async work can create its socket. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('an unexpected drop notifies onClose but not onReopen', async () => {
  const transport = freshTransport();
  const events = [];
  transport.onClose(() => events.push('close'));
  transport.onReopen(() => events.push('reopen'));

  const connecting = transport.connect('ABC123', 'peer_aaaaaaaa');
  latest().open();
  await connecting;

  latest().drop();

  assert.deepEqual(events, ['close']);
  await transport.disconnect();
});

test('a successful reconnect fires onReopen', async () => {
  const transport = freshTransport();
  const events = [];
  transport.onClose(() => events.push('close'));
  transport.onReopen(() => events.push('reopen'));

  const connecting = transport.connect('ABC123', 'peer_aaaaaaaa');
  latest().open();
  await connecting;

  latest().drop();

  // Backoff for the first retry is ~1s plus jitter.
  await new Promise((resolve) => setTimeout(resolve, 1400));
  assert.equal(FakeWebSocket.instances.length, 2, 'a retry socket should exist');

  latest().open();

  // Regression: a reconnect resolves no promise, so without this notification
  // nothing downstream learns the session is live and the UI stayed on
  // "Reconnecting" indefinitely.
  assert.deepEqual(events, ['close', 'reopen']);
  assert.equal(transport.isConnected(), true);

  await transport.disconnect();
});

test('the initial connect does not fire onReopen', async () => {
  const transport = freshTransport();
  const events = [];
  transport.onReopen(() => events.push('reopen'));

  const connecting = transport.connect('ABC123', 'peer_aaaaaaaa');
  latest().open();
  await connecting;

  assert.deepEqual(events, []);
  await transport.disconnect();
});

test('an intentional disconnect does not reconnect', async () => {
  const transport = freshTransport();
  const events = [];
  transport.onClose(() => events.push('close'));

  const connecting = transport.connect('ABC123', 'peer_aaaaaaaa');
  latest().open();
  await connecting;

  await transport.disconnect();
  assert.equal(latest().closedWith.code, 1000);

  await new Promise((resolve) => setTimeout(resolve, 1400));

  assert.equal(FakeWebSocket.instances.length, 1, 'must not retry after leaving');
  assert.deepEqual(events, []);
});

test('the room and peer are embedded in the socket URL', async () => {
  const transport = freshTransport();

  const connecting = transport.connect('ABC123', 'peer_aaaaaaaa');
  latest().open();
  await connecting;

  assert.match(latest().url, /\/ws\/ABC123\/peer_aaaaaaaa$/);
  await transport.disconnect();
});

test('send is refused while the socket is not open', async () => {
  const transport = freshTransport();

  const connecting = transport.connect('ABC123', 'peer_aaaaaaaa');
  const socket = latest();
  socket.open();
  await connecting;

  socket.readyState = 3; // Closing, before onclose has fired
  transport.send({ type: 'PLAY' });

  assert.deepEqual(socket.sent, []);
  await transport.disconnect();
});

test('a second connect replaces the first socket rather than orphaning it', async () => {
  const transport = freshTransport();

  const first = transport.connect('ABC123', 'peer_aaaaaaaa');
  latest().open();
  await first;
  const firstSocket = latest();

  // connect() awaits disconnect() before opening the replacement, so the new
  // socket does not exist until the event loop turns.
  const second = transport.connect('XYZ789', 'peer_aaaaaaaa');
  await tick();
  latest().open();
  await second;

  assert.equal(firstSocket.closedWith.code, 1000);
  assert.match(latest().url, /XYZ789/);
  await transport.disconnect();
});
