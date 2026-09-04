# SyncTube Wire Protocol

Version: 0.3.0

## Overview

SyncTube uses a single JSON envelope format for **all** messages, regardless of
whether they travel over WebSocket (signaling + relay) or WebRTC DataChannel
(P2P). This means the `SyncEngine` never needs to know which transport
delivered a message.

## Message Envelope

```json
{
  "type": "PLAY | PAUSE | SEEK | DRIFT | FORCE_SYNC | HEARTBEAT | PING | PONG | JOIN | LEAVE | HOST_CHANGE | SDP_OFFER | SDP_ANSWER | ICE_CANDIDATE | ROOM_STATE | REQUEST_STATE",
  "roomId": "string",
  "senderId": "string",
  "lamportClock": 42,
  "payload": {
    "videoTime": 123.45,
    "videoId": "dQw4w9WgXcQ",
    "originTimestamp": 1737000000000
  }
}
```

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `type` | `string` | Message type (see [Message Types](#message-types)) |
| `roomId` | `string` | 6-character room code (e.g., `"A3X7K2"`) |
| `senderId` | `string` | Unique peer ID of the sender (e.g., `"peer_a1b2c3d4"`) |
| `lamportClock` | `number` | Lamport logical clock value for causal ordering |
| `payload` | `object` | Type-specific data (see below) |

### Lamport Clock Semantics

Every peer maintains a Lamport logical clock:

1. **On local event**: `clock++` before sending
2. **On message receipt**: `clock = max(local, received) + 1`

This ensures a total ordering of all events across the distributed system,
used to deterministically resolve concurrent commands.

The server rejects a clock that jumps more than 100 ahead of a peer's last
value, or that moves backwards, as a spoofing attempt. `KEEPALIVE` omits the
field entirely and is exempt for the same reason signaling is.

**Signaling is exempt from that check.** `SDP_OFFER`, `SDP_ANSWER` and
`ICE_CANDIDATE` describe how a transport gets built, not what happened to the
video, so they take no part in the causal ordering and are sent with
`lamportClock: 0`. Validating them against a peer's advancing clock reads that
0 as a clock running backwards — which drops every offer, answer and candidate
while every other message flows normally, so WebRTC can never connect and the
room silently stays on the relay forever. Signaling still refreshes the peer's
liveness timestamp, so a peer mid-negotiation is not reaped as silent.

### Latency Compensation

`payload.originTimestamp` is the sender's wall-clock time (`Date.now()`) when
the command was issued.

A command takes real time to travel. By the time it arrives, a *playing* sender
has already moved past the position it sent, so applying that position verbatim
settles the whole room one network delay behind whoever acted. The receiver
therefore advances the target by the estimated one-way delay:

```
compensatedTime = payload.videoTime + oneWayDelay
```

Two rules govern this, and both matter:

**Delay is measured by round trip, never by subtracting timestamps.**
`localReceiveTime - originTimestamp` is *one-way delay plus the difference
between the two machines' clocks*. Those clocks are independent and routinely
disagree by seconds, so that subtraction can even come out negative. Timing a
round trip against a single clock cancels the offset out — this is Cristian's
algorithm, and it is why `PING`/`PONG` exists. The timestamp difference is used
only to bootstrap the first moments of a session, before any sample exists.

**A paused position is never compensated.** A paused video is not advancing, so
adding delay would push every peer *ahead* of the sender — the same bug with the
sign flipped.

The estimate is the **median** of the last 10 round trips, halved. RTT
distributions are heavily right-skewed: a mean chases the occasional spike from
a scheduling hiccup and stays inflated for the next ten samples.

When the room is running over WebRTC, the estimate comes from the transport's
own succeeded ICE candidate pair (`RTCPeerConnection.getStats()`) instead, which
measures the path directly rather than absorbing service-worker wake-up and
message-passing overhead. Samples are discarded whenever the transport changes,
since RTT over a direct path bears no relation to RTT over the relay.

## Message Types

### Playback Sync

| Type | Payload | Description |
|------|---------|-------------|
| `PLAY` | `{ videoTime, videoId, isPaused: false, originTimestamp }` | Resume playback |
| `PAUSE` | `{ videoTime, videoId, isPaused: true, originTimestamp }` | Pause playback |
| `SEEK` | `{ videoTime, videoId, isPaused, originTimestamp }` | Seek to time |
| `DRIFT` | `{ videoTime, videoId, isPaused, originTimestamp }` | Small correction toward the host's position |
| `FORCE_SYNC` | `{ videoTime, videoId, originTimestamp }` | User-initiated full state reconciliation |

`isPaused` travels with every playback command so the receiver knows whether the
position is still advancing, and therefore whether to compensate it.

**`DRIFT` versus `ROOM_STATE`.** Both name a target position, and the difference
is how the receiver is expected to get there. `ROOM_STATE` means *you are
somewhere else entirely* and hard-seeks — correct for a late joiner or a video
switch. `DRIFT` means *you are slightly off*, and the adapter absorbs it by
running playback 6% fast or slow for a few seconds. Corrections arrive every 2
seconds; a visible seek that often would be unwatchable, and it is only because
they are invisible that the drift tolerance can be as tight as 0.35s.

Drift beyond 1.5s is too large to absorb at an imperceptible speed, so the
adapter falls back to a seek.

### Health & Status

| Type | Payload | Description |
|------|---------|-------------|
| `HEARTBEAT` | `{ videoTime, isPaused, videoId, hasActiveTab, originTimestamp }` | Host's position, broadcast every 2s |
| `PING` | `{ hasActiveTab, originTimestamp }` | Non-host asks the host for an RTT sample (every 6s) |
| `PONG` | `{ targetPeerId, pingOriginTimestamp }` | Host's reply, **addressed to the asker only** |
| `ROOM_STATE` | `{ videoTime, isPaused, videoId, peers[], hostId }` | Full room state snapshot (for late joiners and video switches) |
| `REQUEST_STATE` | `{}` | Sent by a joining peer to ask the host to broadcast `ROOM_STATE` |
| `KEEPALIVE` | `{ hasActiveTab, originTimestamp }` | Proof of life, **always over the WebSocket**. Never relayed. |

**`KEEPALIVE` exists because a healthy P2P room looks dead to the server.**
Once the mesh carries playback, every `PLAY`, `PAUSE`, `HEARTBEAT` and `PING`
travels on the DataChannel, and the peer's WebSocket goes completely silent —
indistinguishable from a dropped connection. The stale-peer reaper then closes
the socket of a peer that is working perfectly, and reaping the last one deletes
the room along with the playback position everyone resyncs to, restarting the
video from zero.

It is sent every 15s by host and clients alike, deliberately bypassing transport
selection, and carries **no `lamportClock`** — the peer's real clock has been
advancing over a channel the server never observed, so any value would look like
a jump. The server refreshes liveness and `hasActiveTab` from it and relays it
to nobody.

`PONG` carries `targetPeerId` and is **unicast**, not broadcast. It echoes the
*asker's* `originTimestamp`, so any other peer receiving it would compute
`now - someone_else's_clock` — pure clock offset — and feed that into its RTT
average. Receivers verify `targetPeerId` themselves rather than trusting the
server to have routed correctly.

The heartbeat interval doubles as the upper bound on how long a peer can be out
of sync before anyone notices, which makes it the single biggest lever on
perceived sync quality. Its traffic also keeps the MV3 service worker from
idling out, and counts as inbound traffic against a free-tier host's spin-down
timer.

### Room Management

| Type | Payload | Description |
|------|---------|-------------|
| `JOIN` | `{ peerId, peers[] }` | Peer joined the room |
| `LEAVE` | `{ peerId, reason? }` | Peer left the room (`reason: "timeout"` when reaped) |
| `HOST_CHANGE` | `{ newHostId, previousHostId }` | Host/leader migration |

`ROOM_STATE.peers` is authoritative and is adopted wholesale; `JOIN` and `LEAVE`
are applied on top of it. The client tracks peer **identities**, not a count — a
duplicate `JOIN` or a missed `LEAVE` would otherwise leave the room size
permanently wrong, and the transport decision drifts out of step with it.

### WebRTC Signaling

| Type | Payload | Description |
|------|---------|-------------|
| `SDP_OFFER` | `{ sdp, targetPeerId }` | WebRTC SDP offer |
| `SDP_ANSWER` | `{ sdp, targetPeerId }` | WebRTC SDP answer |
| `ICE_CANDIDATE` | `{ candidate, targetPeerId }` | ICE candidate for NAT traversal |

**Who offers.** Both peers learn about each other at the same moment, so a
symmetric "everyone offers" scheme produces glare and deadlocks. The offerer is
instead chosen deterministically: the peer whose ID sorts lower initiates. Both
sides compute the same role from the same two IDs, so exactly one offer is ever
made and only the offerer creates the DataChannel. Perfect-negotiation rollback
remains underneath as a backstop for a teardown racing an in-flight offer.

**Channel configuration** is `{ ordered: true }` with no retransmit limit —
fully reliable. Capping retransmits makes the channel only *partially* reliable,
and a dropped `PLAY` that never retransmits leaves that peer permanently out of
sync. That costs far more than the few milliseconds of head-of-line blocking
reliability can introduce.

## Transport Selection

| Condition | Transport | Rationale |
|-----------|-----------|-----------|
| Room size ≤ 5 **and** every channel open | WebRTC DataChannel (P2P) | Lower latency, server load stays flat |
| Room size > 5 | WebSocket relay | Avoids O(N²) mesh congestion |
| Mesh only partially formed | WebSocket relay | See below |
| WebRTC negotiation fails | WebSocket relay | Fallback for strict NATs |
| Signaling (SDP/ICE) | WebSocket (always) | Signaling must go through the server |

The mesh is adopted only when **every** expected channel is open, and abandoned
the moment one drops. A partial mesh is worse than the relay: some peers would
receive commands and others silently would not.

While the mesh is active, playback commands arriving over the WebSocket are
discarded, so a message crossing both paths is never applied twice. Structural
messages (`JOIN`, `LEAVE`, `HOST_CHANGE`, `ROOM_STATE`, `PING`, `PONG`,
`HEARTBEAT`) always pass through — they describe the room, are relayed by the
server, and have no P2P equivalent.

### Where WebRTC actually runs

Not in the service worker. WebRTC's interfaces are declared `[Exposed=Window]`,
so `new RTCPeerConnection()` in an MV3 background worker throws
`ReferenceError`. Every peer connection is therefore hosted in an **offscreen
document** (`chrome.offscreen`, reason `WEB_RTC`), with the service worker
driving it over `chrome.runtime` messaging:

```
service worker  ->  which peers exist, routing SDP/ICE over the WebSocket
offscreen page  ->  ICE/DTLS/SCTP mechanics, DataChannel send and receive
```

The offscreen document outlives the service worker, so peer connections survive
a worker restart. On reconnect the worker re-sends `INIT`, which wipes the mesh
and rebuilds it from the authoritative peer list.

### ICE servers

`GET /turn-credentials` returns an `iceServers` array. STUN alone only works
where a direct path can form; symmetric NAT and carrier-grade NAT (most mobile
networks) need a TURN relay, and without one those peers silently never connect
and the room falls back to the relay forever.

TURN credentials are minted **server-side** with a TTL, so the long-term key
never ships in the extension and a leaked credential expires on its own. With no
key configured the endpoint degrades to STUN-only rather than failing.

## IPC Messages (chrome.runtime)

Internal messages between the extension's content script, popup, and
background service worker follow a simpler format:

```json
{
  "action": "ACTION_NAME",
  "payload": { ... }
}
```

### Content Script → Background

| Action | Payload | Description |
|--------|---------|-------------|
| `SYNC_ACTION` | `{ type, data }` | Forward a playback action (PLAY/PAUSE/SEEK) to the room |
| `VIDEO_CHANGED` | `{ videoId }` | Notify background that the user navigated to a different video |
| `INTERRUPTION_START` | `{ videoId, videoTime }` | Buffering or ad began |
| `INTERRUPTION_END` | `{ videoId, videoTime }` | Buffering or ad ended |
| `GET_STATUS` | `{}` | Request current engine status |

### Popup → Background

| Action | Payload | Description |
|--------|---------|-------------|
| `CREATE_ROOM` | `{}` | Create a new room |
| `JOIN_ROOM` | `{ roomId }` | Join an existing room by code |
| `LEAVE_ROOM` | `{}` | Leave the current room |
| `GET_STATUS` | `{}` | Request current engine status |
| `FORCE_SYNC` | `{}` | User-initiated full state reconciliation |

### Background → Content Script

| Action | Payload | Description |
|--------|---------|-------------|
| `APPLY_COMMAND` | `{ type, command }` | Execute a remote command with echo suppression |
| `UPDATE_STATUS` | `{ state, roomId, isHost, transport, peerCount, rttMs, ... }` | Push status update to overlay UI and popup |
| `SHOW_TOAST` | `{ text, duration }` | Display a temporary notification on the overlay |
| `GET_VIDEO_STATE` | `{}` | Request current video state (videoId, videoTime, isPaused, etc.) |
| `GET_DEBUG_STATE` | `{}` | Request full adapter debug snapshot |

The status payload **must** be sent under the key `payload`. Both `popup.js` and
`content-script.js` read `message.payload`; any other key drops every live
update silently and freezes both UIs on their initial render.

### Service Worker ↔ Offscreen Document

Routed on the same `chrome.runtime` bus, distinguished by a `target` field so
neither side answers the other's messages.

| Direction | `target` | Fields |
|-----------|----------|--------|
| worker → offscreen | `synctube-offscreen` | `op`: `INIT`, `SYNC_PEERS`, `REMOVE_PEER`, `HANDLE_OFFER`, `HANDLE_ANSWER`, `HANDLE_ICE`, `SEND`, `GET_STATE`, `GET_RTT`, `TEARDOWN` |
| offscreen → worker | `synctube-worker` | `event`: `SIGNALING`, `MESSAGE`, `CHANNEL_STATE` |

`SYNC_PEERS` carries the room's **whole** peer list rather than add/remove
deltas, so a dropped `JOIN`, a missed `LEAVE`, or a worker restart cannot leave
the mesh permanently inconsistent — the next `ROOM_STATE` repairs it.

These never leave the browser and are not part of the wire protocol.
