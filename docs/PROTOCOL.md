# SyncTube Wire Protocol

Version: 0.2.0

## Overview

SyncTube uses a single JSON envelope format for **all** messages, regardless of
whether they travel over WebSocket (signaling + relay) or WebRTC DataChannel
(P2P). This means the `SyncEngine` never needs to know which transport
delivered a message.

## Message Envelope

```json
{
  "type": "PLAY | PAUSE | SEEK | FORCE_SYNC | HEARTBEAT | JOIN | LEAVE | HOST_CHANGE | SDP_OFFER | SDP_ANSWER | ICE_CANDIDATE | ROOM_STATE | REQUEST_STATE",
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

### Origin Timestamp

`payload.originTimestamp` is the sender's wall-clock time (`Date.now()`) when
the command was issued. Used by `ClockSync` for latency compensation:

```
oneWayDelay = (localReceiveTime - originTimestamp) / 2
compensatedSeekTime = payload.videoTime + (oneWayDelay / 1000)
```

## Message Types

### Playback Sync

| Type | Payload | Description |
|------|---------|-------------|
| `PLAY` | `{ videoTime, videoId, originTimestamp }` | Resume playback |
| `PAUSE` | `{ videoTime, videoId, originTimestamp }` | Pause playback |
| `SEEK` | `{ videoTime, videoId, originTimestamp }` | Seek to time |
| `FORCE_SYNC` | `{ videoTime, videoId, originTimestamp }` | User-initiated full state reconciliation |

### Health & Status

| Type | Payload | Description |
|------|---------|-------------|
| `HEARTBEAT` | `{ videoTime, isPaused, videoId, originTimestamp }` | Periodic state broadcast (every 5s) |
| `ROOM_STATE` | `{ videoTime, isPaused, videoId, peers[], hostId }` | Full room state snapshot (for late joiners and video switches) |
| `REQUEST_STATE` | `{}` | Sent by a joining peer to ask the host to broadcast `ROOM_STATE` |

### Room Management

| Type | Payload | Description |
|------|---------|-------------|
| `JOIN` | `{ peerId }` | Peer joined the room |
| `LEAVE` | `{ peerId }` | Peer left the room |
| `HOST_CHANGE` | `{ newHostId, previousHostId }` | Host/leader migration |

### WebRTC Signaling

| Type | Payload | Description |
|------|---------|-------------|
| `SDP_OFFER` | `{ sdp, targetPeerId }` | WebRTC SDP offer |
| `SDP_ANSWER` | `{ sdp, targetPeerId }` | WebRTC SDP answer |
| `ICE_CANDIDATE` | `{ candidate, targetPeerId }` | ICE candidate for NAT traversal |

## Transport Selection

| Condition | Transport | Rationale |
|-----------|-----------|-----------|
| Room size ≤ 5 | WebRTC DataChannel (P2P) | Lower latency, server load stays flat |
| Room size > 5 | WebSocket relay | Avoids O(N²) mesh congestion |
| WebRTC negotiation fails | WebSocket relay | Fallback for strict NATs |
| Signaling (SDP/ICE) | WebSocket (always) | Signaling must go through the server |

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
| `PING` | `{}` | Keep-alive to prevent MV3 SW sleep (temporary, see BO8) |
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
| `UPDATE_STATUS` | `{ state, roomId, ... }` | Push status update to overlay UI |
| `SHOW_TOAST` | `{ text, duration }` | Display a temporary notification on the overlay |
| `GET_VIDEO_STATE` | `{}` | Request current video state (videoId, videoTime, isPaused, etc.) |
| `GET_DEBUG_STATE` | `{}` | Request full adapter debug snapshot |

These never leave the browser and are not part of the wire protocol.
