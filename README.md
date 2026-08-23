# SyncTube

> A Chrome Extension and FastAPI server system that synchronizes YouTube video playback (play, pause, seek) across multiple users in a shared room via WebSocket relay and WebRTC P2P.

## Overview

SyncTube allows users to watch YouTube videos together in perfect synchronization. The system consists of two main components:
1. **Chrome Extension (Manifest V3):** Injects into YouTube tabs to monitor and control playback, handling peer-to-peer and WebSocket communication through a background service worker.
2. **FastAPI Server:** A lightweight Python signaling server that manages room state, orchestrates WebRTC connections, and falls back to acting as a WebSocket message relay for larger rooms.

## Architecture & Features

- **Hybrid Transport Model:** Automatically uses low-latency WebRTC DataChannels (P2P) for small rooms (≤ 5 users) and scales up to WebSocket relay for larger rooms to optimize network utilization.
- **Latency Compensation:** Utilizes Lamport logical clocks and origin timestamps to calculate RTT (Round Trip Time) and compensate for network latency during synchronization commands.
- **Robust State Management:** Gracefully handles buffering, advertisement interruptions, and late joiners via a deterministic state machine and host election protocols.

## Documentation

For comprehensive technical specifications, system design, message structures, and wire protocols, please refer to the `docs/` directory:

- [Project Reference](docs/PROJECT_REFERENCE.md): Complete architecture breakdown, process models, file trees, and component APIs.
- [SyncTube Technical Reference](docs/SyncTube_Tech_Ref_[FIXED].md): Extended technical documentation and architectural diagrams.
- [Wire Protocol](docs/PROTOCOL.md): Detailed explanation of the JSON envelope format, Lamport clock semantics, and all WebSocket/WebRTC message types.

## Repository Structure

- **`server/`**: The FastAPI application for signaling and WebSocket relays.
- **`extension/`**: The MV3 Chrome extension source code, including background service workers, content scripts, and user interface components.
- **`docs/`**: Core technical architecture and reference documentation.
