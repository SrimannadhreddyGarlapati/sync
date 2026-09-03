/**
 * A fake WebRTC stack, enough to drive the offscreen document's negotiation.
 *
 * Models the state machine the offscreen code depends on: signalingState moves
 * with setLocalDescription/setRemoteDescription, candidates are rejected before
 * a remote description exists, and createDataChannel raises negotiationneeded.
 */

export class FakeDataChannel {
  constructor(label, options = {}) {
    this.label = label;
    this.options = options;
    this.readyState = 'connecting';

    /** @type {string[]} Everything sent over this channel */
    this.sent = [];

    this.onopen = null;
    this.onclose = null;
    this.onmessage = null;
    this.onerror = null;
  }

  send(data) {
    if (this.readyState !== 'open') throw new Error('InvalidStateError');
    this.sent.push(data);
  }

  /** Simulate the channel finishing negotiation. */
  open() {
    this.readyState = 'open';
    if (this.onopen) this.onopen();
  }

  close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    if (this.onclose) this.onclose();
  }

  /** Simulate an inbound message. */
  receive(data) {
    if (this.onmessage) this.onmessage({ data });
  }
}

export class FakeRTCPeerConnection {
  /** @type {FakeRTCPeerConnection[]} Every instance created, for assertions */
  static instances = [];

  static reset() {
    FakeRTCPeerConnection.instances = [];
  }

  constructor(config = {}) {
    this.config = config;
    this.signalingState = 'stable';
    this.iceConnectionState = 'new';
    this.connectionState = 'new';
    this.localDescription = null;
    this.remoteDescription = null;
    this.closed = false;

    /** @type {object[]} Candidates successfully added */
    this.addedCandidates = [];

    /** @type {FakeDataChannel[]} */
    this.channels = [];

    /** @type {number} restartIce call count */
    this.iceRestarts = 0;

    this.onicecandidate = null;
    this.ondatachannel = null;
    this.onnegotiationneeded = null;
    this.oniceconnectionstatechange = null;
    this.onconnectionstatechange = null;

    FakeRTCPeerConnection.instances.push(this);
  }

  createDataChannel(label, options) {
    const channel = new FakeDataChannel(label, options);
    this.channels.push(channel);

    // Creating a channel is what triggers negotiation in a real stack.
    if (this.onnegotiationneeded) {
      Promise.resolve().then(() => {
        if (!this.closed && this.onnegotiationneeded) this.onnegotiationneeded();
      });
    }

    return channel;
  }

  async setLocalDescription(description) {
    // The parameterless form derives the right type from signalingState,
    // which is what perfect negotiation relies on.
    const type = description?.type
      || (this.remoteDescription?.type === 'offer' ? 'answer' : 'offer');

    this.localDescription = {
      type,
      sdp: `local-${type}-sdp`,
      toJSON() { return { type: this.type, sdp: this.sdp }; },
    };

    this.signalingState = type === 'offer' ? 'have-local-offer' : 'stable';
  }

  async setRemoteDescription(description) {
    const type = description.type;

    this.remoteDescription = {
      type,
      sdp: description.sdp,
      toJSON() { return { type: this.type, sdp: this.sdp }; },
    };

    this.signalingState = type === 'offer' ? 'have-remote-offer' : 'stable';
  }

  async addIceCandidate(candidate) {
    if (!this.remoteDescription) {
      throw new Error('InvalidStateError: remote description not set');
    }
    this.addedCandidates.push(candidate);
  }

  async getStats() {
    return new Map([
      ['pair', {
        type: 'candidate-pair',
        state: 'succeeded',
        currentRoundTripTime: 0.042,
      }],
    ]);
  }

  restartIce() {
    this.iceRestarts++;
  }

  close() {
    this.closed = true;
    this.signalingState = 'closed';
  }

  // ── Test drivers ───────────────────────────────────────────────

  /** Simulate ICE producing a candidate. */
  emitCandidate(candidate = { candidate: 'candidate:1 1 udp 100 1.2.3.4 5000 typ host' }) {
    if (this.onicecandidate) {
      this.onicecandidate({
        candidate: { ...candidate, toJSON: () => candidate },
      });
    }
  }

  /** Simulate the remote peer opening a channel toward us. */
  emitRemoteChannel(label = 'sync') {
    const channel = new FakeDataChannel(label);
    if (this.ondatachannel) this.ondatachannel({ channel });
    return channel;
  }

  setIceState(state) {
    this.iceConnectionState = state;
    if (this.oniceconnectionstatechange) this.oniceconnectionstatechange();
  }

  setConnectionState(state) {
    this.connectionState = state;
    if (this.onconnectionstatechange) this.onconnectionstatechange();
  }
}

export class FakeRTCSessionDescription {
  constructor(init) {
    this.type = init.type;
    this.sdp = init.sdp;
  }
}

export class FakeRTCIceCandidate {
  constructor(init) {
    Object.assign(this, init);
  }
}
