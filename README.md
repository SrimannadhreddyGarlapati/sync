# SyncTube

> A Chrome Extension and FastAPI server system that synchronizes YouTube video playback (play, pause, seek) across multiple users in a shared room via WebSocket relay and WebRTC P2P.

## Overview

SyncTube allows users to watch YouTube videos together in synchronization. The system consists of two main components:

1. **Chrome Extension (Manifest V3):** Injects into YouTube tabs to monitor and control playback, handling peer-to-peer and WebSocket communication through a background service worker.
2. **FastAPI Server:** A lightweight Python signaling server that manages room state, orchestrates WebRTC connections, and falls back to acting as a WebSocket message relay for larger rooms.

## Architecture & Features

- **Hybrid Transport Model:** Uses WebRTC DataChannels (P2P) for rooms of 5 or fewer and a WebSocket relay above that, or whenever the mesh fails to form completely. Because WebRTC is unavailable in an MV3 service worker, peer connections are hosted in an **offscreen document** and driven by the worker over message passing.
- **Latency Compensation:** Round-trip time is measured with Cristian's algorithm (`PING`/`PONG`, or the transport's own ICE candidate-pair statistics when running P2P) and used to advance every incoming playback position by the time it spent in flight.
- **Invisible Drift Correction:** Continuous correction toward the host, absorbed by running playback ±6% off-speed rather than seeking, so routine corrections cannot be seen or heard. Only drift too large to absorb falls back to a seek.
- **Robust State Management:** Handles buffering, advertisement interruptions, and late joiners via a deterministic state machine and a host election protocol.

## Sync Accuracy

| Property | Value |
|----------|-------|
| Drift tolerance before correcting | 0.35 s |
| Worst-case time to notice drift | 2 s (the heartbeat interval) |
| Correction method under 1.5 s | playback rate, ±6% |
| Correction method at or above 1.5 s | seek |

## Getting Started

### Server

```bash
cd server
python -m venv .venv && . .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
PYTHONPATH=. uvicorn main:app --reload
```

### Extension

Load `extension/` as an unpacked extension via `chrome://extensions` → Developer
mode → **Load unpacked**. Requires Chrome 116 or newer (`chrome.runtime.getContexts`).

### Tests

```bash
cd extension && npm test          # 121 tests, no dependencies
cd server && PYTHONPATH=. pytest  # 25 tests
```

## Configuration

All server settings are environment variables; every one is optional and has a
safe default.

| Variable | Default | Effect |
|----------|---------|--------|
| `DEBUG` | `false` | Verbose request logging |
| `ALLOWED_EXTENSION_IDS` | *(unset)* | Comma-separated extension IDs allowed to open WebSockets. Unset accepts any origin and logs a warning. |
| `CLOUDFLARE_TURN_KEY_ID` | *(unset)* | Cloudflare Realtime TURN key ID |
| `CLOUDFLARE_TURN_API_TOKEN` | *(unset)* | Cloudflare Realtime TURN API token |
| `TURN_CREDENTIAL_TTL_S` | `3600` | Lifetime of a minted TURN credential |

### TURN

Without TURN, WebRTC works between peers that can form a direct path — the same
LAN, or friendly NATs — and silently fails behind symmetric NAT or
carrier-grade NAT, which covers most mobile networks. Those rooms fall back to
the WebSocket relay and still work; they just lose the P2P latency benefit.

To enable it, create a TURN key in the Cloudflare dashboard (Realtime → TURN)
and set the two variables above. `GET /turn-credentials` then mints short-lived
credentials per client, so the long-term key never ships inside the extension.
Cloudflare's free allowance is 1000 GB/month.

### Deployment notes

The server is deployed on Render's free tier, which is a reasonable fit:
WebSocket messages count as inbound traffic, so an active room keeps the service
awake on its own. Only the first joiner after 15 minutes of complete idle pays
the ~1 minute cold start.

Pick the region closest to your users at service creation — Render cannot change
a service's region in place.

## Documentation

For comprehensive technical specifications, system design, message structures, and wire protocols, please refer to the `docs/` directory:

- [Project Reference](docs/PROJECT_REFERENCE.md): Complete architecture breakdown, process models, file trees, and component APIs.
- [SyncTube Technical Reference](docs/SyncTube_Tech_Ref_[FIXED].md): Extended technical documentation and architectural diagrams.
- [Wire Protocol](docs/PROTOCOL.md): The JSON envelope format, Lamport clock semantics, latency-compensation rules, and all WebSocket/WebRTC message types.

## Repository Structure

- **`server/`**: The FastAPI application for signaling and WebSocket relays.
- **`extension/`**: The MV3 Chrome extension source code — background service worker, offscreen WebRTC host, content scripts, and UI.
- **`docs/`**: Core technical architecture and reference documentation.
