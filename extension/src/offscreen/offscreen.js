/**
 * Offscreen WebRTC Host
 *
 * Owns every RTCPeerConnection and RTCDataChannel for the extension.
 *
 * Why this file exists
 * --------------------
 * WebRTC's interfaces are declared `[Exposed=Window]`, so an MV3 background
 * service worker has no RTCPeerConnection at all — constructing one throws
 * ReferenceError. An offscreen document is a real (invisible) DOM context, so
 * it can hold the connections. The service worker remains the single owner of
 * signaling, room state, and the sync protocol; this page is a dumb executor.
 *
 * Division of responsibility
 * --------------------------
 *   service worker  ->  which peers exist, routing SDP/ICE over the WebSocket
 *   this page       ->  ICE/DTLS/SCTP mechanics, DataChannel send and receive
 *
 * Glare-free negotiation
 * ----------------------
 * Both peers learn about each other at roughly the same moment, so a naive
 * implementation has both send an offer and deadlock. Rather than detect and
 * recover from that collision, the offerer is chosen deterministically: the
 * peer whose ID sorts lower initiates. Both sides compute the same answer from
 * the same two IDs, so exactly one offer is ever made. Perfect-negotiation
 * rollback is still implemented underneath as a backstop for the case where a
 * connection is torn down and rebuilt while an offer is in flight.
 */

'use strict';

const TAG = '[SyncTube:Offscreen]';

/** Messages addressed to this page. */
const INBOUND_TARGET = 'synctube-offscreen';

/** Messages this page sends back to the service worker. */
const OUTBOUND_TARGET = 'synctube-worker';

/** Label of the single DataChannel opened per peer. */
const CHANNEL_LABEL = 'sync';

const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

// ── Module state ────────────────────────────────────────────────

/** @type {string|null} */
let localPeerId = null;

/** @type {string|null} */
let roomId = null;

/** @type {RTCIceServer[]} */
let iceServers = DEFAULT_ICE_SERVERS;

/**
 * One entry per remote peer.
 * @type {Map<string, {
 *   pc: RTCPeerConnection,
 *   channel: RTCDataChannel|null,
 *   pendingCandidates: RTCIceCandidateInit[],
 *   makingOffer: boolean,
 *   ignoreOffer: boolean,
 *   settingRemoteAnswer: boolean,
 *   initiator: boolean,
 * }>}
 */
const peers = new Map();

// ── Outbound messaging ──────────────────────────────────────────

/**
 * Notify the service worker. Failures are expected and ignored: the worker may
 * be asleep, in which case the message wakes it, and a genuinely closed port
 * only means the room is gone.
 * @param {object} message
 */
function notifyWorker(message) {
  chrome.runtime
    .sendMessage({ target: OUTBOUND_TARGET, ...message })
    .catch(() => {});
}

/**
 * Ask the service worker to relay an SDP or ICE message to one peer.
 * @param {string} type - SDP_OFFER | SDP_ANSWER | ICE_CANDIDATE
 * @param {string} targetPeerId
 * @param {object} body
 */
function sendSignaling(type, targetPeerId, body) {
  notifyWorker({ event: 'SIGNALING', signalType: type, targetPeerId, body });
}

/** Report how many channels are currently usable so the worker can pick a transport. */
function reportChannelState() {
  notifyWorker({
    event: 'CHANNEL_STATE',
    openChannels: countOpenChannels(),
    totalPeers: peers.size,
  });
}

// ── Peer bookkeeping ────────────────────────────────────────────

/**
 * True if this peer is the one responsible for sending the offer.
 * Deterministic and symmetric: both sides compute the same result.
 * @param {string} remotePeerId
 * @returns {boolean}
 */
function isInitiator(remotePeerId) {
  return String(localPeerId) < String(remotePeerId);
}

/** @returns {number} */
function countOpenChannels() {
  let count = 0;
  for (const entry of peers.values()) {
    if (entry.channel && entry.channel.readyState === 'open') count++;
  }
  return count;
}

/**
 * Create the RTCPeerConnection for a peer and wire up its handlers.
 * @param {string} remotePeerId
 * @returns {object} the peers-map entry
 */
function createPeerEntry(remotePeerId) {
  const pc = new RTCPeerConnection({
    iceServers,
    // A single bundled transport for one DataChannel: fewer ports to punch,
    // so the connection comes up faster and survives stricter NATs.
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
    // Warm the candidate pool so gathering overlaps offer creation instead of
    // following it, which measurably shortens time-to-first-byte on the channel.
    iceCandidatePoolSize: 2,
  });

  const entry = {
    pc,
    channel: null,
    pendingCandidates: [],
    makingOffer: false,
    ignoreOffer: false,
    settingRemoteAnswer: false,
    initiator: isInitiator(remotePeerId),
  };
  peers.set(remotePeerId, entry);

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendSignaling('ICE_CANDIDATE', remotePeerId, { candidate: event.candidate.toJSON() });
    }
  };

  pc.onnegotiationneeded = async () => {
    // Only the initiator negotiates; the answerer's channel arrives via
    // ondatachannel and needs no local offer.
    if (!entry.initiator) return;

    try {
      entry.makingOffer = true;
      await pc.setLocalDescription();
      sendSignaling('SDP_OFFER', remotePeerId, { sdp: pc.localDescription.toJSON() });
    } catch (err) {
      console.error(`${TAG} Failed to create offer for ${remotePeerId}:`, err);
    } finally {
      entry.makingOffer = false;
    }
  };

  pc.ondatachannel = (event) => {
    console.log(`${TAG} Incoming DataChannel from ${remotePeerId}`);
    attachChannel(remotePeerId, event.channel);
  };

  pc.oniceconnectionstatechange = () => {
    console.log(`${TAG} ICE state for ${remotePeerId}: ${pc.iceConnectionState}`);

    // 'disconnected' is frequently transient — a brief network blip on mobile
    // recovers on its own. Only a genuine 'failed' warrants an ICE restart, and
    // tearing the connection down here would lose a recoverable path.
    if (pc.iceConnectionState === 'failed') {
      if (entry.initiator) {
        console.warn(`${TAG} ICE failed for ${remotePeerId}; restarting ICE`);
        try {
          pc.restartIce();
        } catch (err) {
          console.error(`${TAG} restartIce failed for ${remotePeerId}:`, err);
        }
      }
    }
  };

  pc.onconnectionstatechange = () => {
    console.log(`${TAG} Connection state for ${remotePeerId}: ${pc.connectionState}`);
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      reportChannelState();
    }
  };

  return entry;
}

/**
 * Wire up a DataChannel's handlers and record it against its peer.
 * @param {string} remotePeerId
 * @param {RTCDataChannel} channel
 */
function attachChannel(remotePeerId, channel) {
  const entry = peers.get(remotePeerId);
  if (!entry) {
    channel.close();
    return;
  }

  entry.channel = channel;

  channel.onopen = () => {
    console.log(`${TAG} DataChannel open for ${remotePeerId}`);
    reportChannelState();
  };

  channel.onclose = () => {
    console.log(`${TAG} DataChannel closed for ${remotePeerId}`);
    if (entry.channel === channel) entry.channel = null;
    reportChannelState();
  };

  channel.onerror = (event) => {
    // An 'error' whose code is a benign remote close is not worth surfacing.
    const err = event && event.error;
    if (err && err.name === 'OperationError') return;
    console.error(`${TAG} DataChannel error for ${remotePeerId}:`, err || event);
  };

  channel.onmessage = (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (err) {
      console.error(`${TAG} Unparseable message from ${remotePeerId}:`, err);
      return;
    }
    notifyWorker({ event: 'MESSAGE', message, fromPeerId: remotePeerId });
  };
}

/**
 * Begin connecting to a peer. Idempotent.
 * @param {string} remotePeerId
 */
function addPeer(remotePeerId) {
  if (!remotePeerId || remotePeerId === localPeerId) return;
  if (peers.has(remotePeerId)) return;

  const entry = createPeerEntry(remotePeerId);
  console.log(
    `${TAG} Added peer ${remotePeerId} (role=${entry.initiator ? 'offerer' : 'answerer'})`
  );

  if (entry.initiator) {
    // Creating the channel raises 'negotiationneeded', which sends the offer.
    // Reliable and ordered: a dropped PLAY that never retransmits would leave
    // that peer permanently out of sync, which costs far more than the few ms
    // of head-of-line blocking that reliability can introduce.
    const channel = entry.pc.createDataChannel(CHANNEL_LABEL, { ordered: true });
    attachChannel(remotePeerId, channel);
  }
}

/**
 * Tear down a peer's connection and forget it.
 * @param {string} remotePeerId
 */
function removePeer(remotePeerId) {
  const entry = peers.get(remotePeerId);
  if (!entry) return;

  if (entry.channel) {
    entry.channel.onopen = null;
    entry.channel.onclose = null;
    entry.channel.onmessage = null;
    entry.channel.onerror = null;
    try { entry.channel.close(); } catch { /* already closed */ }
  }

  entry.pc.onicecandidate = null;
  entry.pc.ondatachannel = null;
  entry.pc.onnegotiationneeded = null;
  entry.pc.oniceconnectionstatechange = null;
  entry.pc.onconnectionstatechange = null;
  try { entry.pc.close(); } catch { /* already closed */ }

  peers.delete(remotePeerId);
  console.log(`${TAG} Removed peer ${remotePeerId}`);
  reportChannelState();
}

/**
 * Reconcile the connection set against the room's authoritative peer list.
 *
 * Driven by ROOM_STATE / JOIN / LEAVE in the service worker. Diffing against a
 * full list rather than applying deltas means a dropped JOIN or a service-worker
 * restart cannot leave the mesh permanently wrong.
 *
 * @param {string[]} peerIds - every peer in the room, this one included
 */
function syncPeers(peerIds) {
  const desired = new Set(
    (Array.isArray(peerIds) ? peerIds : []).filter((id) => id && id !== localPeerId)
  );

  for (const existing of Array.from(peers.keys())) {
    if (!desired.has(existing)) removePeer(existing);
  }

  for (const wanted of desired) {
    if (!peers.has(wanted)) addPeer(wanted);
  }

  reportChannelState();
}

// ── Signaling handlers ──────────────────────────────────────────

/**
 * @param {string} remotePeerId
 * @param {RTCSessionDescriptionInit} sdp
 */
async function handleOffer(remotePeerId, sdp) {
  let entry = peers.get(remotePeerId);
  if (!entry) {
    // An offer can arrive before the room list does; trust the offer.
    entry = createPeerEntry(remotePeerId);
  }

  const { pc } = entry;

  // Perfect-negotiation collision check. Deterministic initiator selection
  // means this should not normally trigger; it covers a rebuild racing an offer.
  const readyForOffer =
    !entry.makingOffer && (pc.signalingState === 'stable' || entry.settingRemoteAnswer);
  const polite = !entry.initiator;

  entry.ignoreOffer = !polite && !readyForOffer;
  if (entry.ignoreOffer) {
    console.warn(`${TAG} Ignoring colliding offer from ${remotePeerId} (impolite peer)`);
    return;
  }

  try {
    // setRemoteDescription performs the implicit rollback when needed.
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    await drainCandidates(remotePeerId);
    await pc.setLocalDescription();
    sendSignaling('SDP_ANSWER', remotePeerId, { sdp: pc.localDescription.toJSON() });
  } catch (err) {
    console.error(`${TAG} Failed to answer offer from ${remotePeerId}:`, err);
  }
}

/**
 * @param {string} remotePeerId
 * @param {RTCSessionDescriptionInit} sdp
 */
async function handleAnswer(remotePeerId, sdp) {
  const entry = peers.get(remotePeerId);
  if (!entry) {
    console.warn(`${TAG} Answer from unknown peer ${remotePeerId}`);
    return;
  }

  try {
    entry.settingRemoteAnswer = true;
    await entry.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    await drainCandidates(remotePeerId);
  } catch (err) {
    console.error(`${TAG} Failed to apply answer from ${remotePeerId}:`, err);
  } finally {
    entry.settingRemoteAnswer = false;
  }
}

/**
 * ICE candidates routinely arrive before the remote description that gives them
 * meaning, so they are queued until setRemoteDescription lands.
 * @param {string} remotePeerId
 * @param {RTCIceCandidateInit} candidate
 */
async function handleIceCandidate(remotePeerId, candidate) {
  const entry = peers.get(remotePeerId);
  if (!entry) {
    console.warn(`${TAG} ICE candidate from unknown peer ${remotePeerId}`);
    return;
  }

  if (!entry.pc.remoteDescription || !entry.pc.remoteDescription.type) {
    entry.pendingCandidates.push(candidate);
    return;
  }

  try {
    await entry.pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (err) {
    // Expected when an offer was deliberately ignored: its candidates are moot.
    if (!entry.ignoreOffer) {
      console.error(`${TAG} Failed to add ICE candidate from ${remotePeerId}:`, err);
    }
  }
}

/** @param {string} remotePeerId */
async function drainCandidates(remotePeerId) {
  const entry = peers.get(remotePeerId);
  if (!entry || entry.pendingCandidates.length === 0) return;

  const queued = entry.pendingCandidates;
  entry.pendingCandidates = [];

  console.log(`${TAG} Draining ${queued.length} queued ICE candidates for ${remotePeerId}`);
  for (const candidate of queued) {
    try {
      await entry.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      if (!entry.ignoreOffer) {
        console.error(`${TAG} Failed to add queued candidate from ${remotePeerId}:`, err);
      }
    }
  }
}

// ── Data path ───────────────────────────────────────────────────

/**
 * Broadcast an application message to every open channel.
 * @param {object} message
 * @returns {{sent: number, peers: number}}
 */
function broadcast(message) {
  const serialized = JSON.stringify(message);
  let sent = 0;

  for (const [remotePeerId, entry] of peers.entries()) {
    if (!entry.channel || entry.channel.readyState !== 'open') continue;
    try {
      entry.channel.send(serialized);
      sent++;
    } catch (err) {
      console.error(`${TAG} Failed to send to ${remotePeerId}:`, err);
    }
  }

  return { sent, peers: peers.size };
}

/** Close every connection and reset to a clean slate. */
function reset() {
  for (const remotePeerId of Array.from(peers.keys())) {
    removePeer(remotePeerId);
  }
  peers.clear();
}

/**
 * Round-trip time over the negotiated ICE candidate pair, in milliseconds.
 *
 * This is the true peer-to-peer RTT measured by the transport itself, far more
 * accurate than an application-level PING/PONG, which also absorbs service
 * worker wake-up and message-passing overhead.
 *
 * @returns {Promise<{peerId: string, rttMs: number}[]>}
 */
async function collectRtt() {
  const results = [];

  for (const [remotePeerId, entry] of peers.entries()) {
    if (!entry.channel || entry.channel.readyState !== 'open') continue;

    try {
      const stats = await entry.pc.getStats();
      let rttMs = null;

      stats.forEach((report) => {
        if (
          report.type === 'candidate-pair' &&
          report.state === 'succeeded' &&
          typeof report.currentRoundTripTime === 'number'
        ) {
          rttMs = report.currentRoundTripTime * 1000;
        }
      });

      if (rttMs !== null) results.push({ peerId: remotePeerId, rttMs });
    } catch (err) {
      console.debug(`${TAG} getStats failed for ${remotePeerId}:`, err);
    }
  }

  return results;
}

// ── Command dispatch from the service worker ────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== INBOUND_TARGET) return false;

  (async () => {
    try {
      switch (message.op) {
        case 'INIT': {
          // A fresh room, or a service-worker restart. Either way, start clean:
          // the worker's view of the mesh is authoritative.
          reset();
          localPeerId = message.peerId || null;
          roomId = message.roomId || null;
          if (Array.isArray(message.iceServers) && message.iceServers.length > 0) {
            iceServers = message.iceServers;
          }
          console.log(
            `${TAG} Initialized for room=${roomId} peer=${localPeerId} ` +
            `(${iceServers.length} ICE servers)`
          );
          sendResponse({ success: true });
          break;
        }

        case 'SYNC_PEERS':
          syncPeers(message.peerIds);
          sendResponse({ success: true, openChannels: countOpenChannels() });
          break;

        case 'REMOVE_PEER':
          removePeer(message.peerId);
          sendResponse({ success: true });
          break;

        case 'HANDLE_OFFER':
          await handleOffer(message.peerId, message.sdp);
          sendResponse({ success: true });
          break;

        case 'HANDLE_ANSWER':
          await handleAnswer(message.peerId, message.sdp);
          sendResponse({ success: true });
          break;

        case 'HANDLE_ICE':
          await handleIceCandidate(message.peerId, message.candidate);
          sendResponse({ success: true });
          break;

        case 'SEND':
          sendResponse({ success: true, ...broadcast(message.message) });
          break;

        case 'GET_STATE':
          sendResponse({
            success: true,
            openChannels: countOpenChannels(),
            totalPeers: peers.size,
            peerIds: Array.from(peers.keys()),
          });
          break;

        case 'GET_RTT':
          sendResponse({ success: true, samples: await collectRtt() });
          break;

        case 'TEARDOWN':
          reset();
          localPeerId = null;
          roomId = null;
          sendResponse({ success: true });
          break;

        default:
          sendResponse({ success: false, error: `Unknown op: ${message.op}` });
      }
    } catch (err) {
      console.error(`${TAG} Error handling op ${message.op}:`, err);
      sendResponse({ success: false, error: err.message });
    }
  })();

  return true; // async sendResponse
});

console.log(`${TAG} WebRTC host ready`);
