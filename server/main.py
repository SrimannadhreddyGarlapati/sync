import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Path
from fastapi.middleware.cors import CORSMiddleware

from app.core.signaling import handle_websocket
from app.core.turn import get_ice_servers
from app.managers.connection_manager import manager
from app.config import config

# Configure logging with comprehensive formatting and module tracking
logging.basicConfig(
    level=logging.DEBUG if config.DEBUG else logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S"
)
logger = logging.getLogger("synctube.main")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Run the stale-peer reaper for the lifetime of the process."""
    manager.start_reaper()
    if not config.ALLOWED_EXTENSION_IDS:
        logger.warning(
            "ALLOWED_EXTENSION_IDS is unset: accepting WebSocket connections from "
            "any origin. Set it to your extension ID to lock this down."
        )
    if not config.turn_enabled:
        logger.warning(
            "Cloudflare TURN is not configured: /turn-credentials serves STUN only. "
            "Peers behind symmetric NAT or CGNAT will fail to establish WebRTC."
        )
    try:
        yield
    finally:
        await manager.stop_reaper()


# Initialize FastAPI application with OpenAPI metadata
app = FastAPI(
    title="SyncTube Signaling Server",
    description="WebSocket signaling relay and state management for the SyncTube Chrome Extension",
    version="1.0.0",
    lifespan=lifespan,
)

# Configure CORS for HTTP endpoints.
# Note: CORSMiddleware strictly applies to HTTP. WebSockets bypass it (their
# origin is checked in the endpoint below), but it governs the health check and
# /turn-credentials.
#
# allow_credentials must stay False alongside a wildcard origin: the Fetch spec
# forbids `Access-Control-Allow-Origin: *` on a credentialed request, so the
# pair silently breaks the very requests it appears to permit. No endpoint here
# uses cookies or HTTP auth, so nothing needs credentials.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/", tags=["Health"])
async def root() -> dict:
    """
    Health check endpoint for load balancers and deployment monitoring.
    Matches the blueprint requirement.
    """
    return {"message": "SyncTube Signaling Server is running!"}


@app.get("/turn-credentials", tags=["WebRTC"])
async def turn_credentials() -> dict:
    """
    Hand the extension a short-lived `iceServers` array for RTCPeerConnection.

    The long-term TURN key never leaves the server; clients receive credentials
    that expire, so a leaked one stops working on its own.
    """
    return await get_ice_servers()


def _origin_allowed(origin: str | None) -> bool:
    """
    Check a WebSocket handshake Origin against the configured allowlist.

    Browsers set Origin on the WebSocket handshake and forbid scripts from
    overriding it, so this keeps arbitrary web pages from opening rooms on this
    server. It is not a defence against a non-browser client, which can send
    any origin it likes.
    """
    if not config.ALLOWED_EXTENSION_IDS:
        return True  # Allowlist not configured; see the lifespan warning.

    if not origin:
        return False

    return any(
        origin == f"chrome-extension://{ext_id}"
        for ext_id in config.ALLOWED_EXTENSION_IDS
    )


@app.websocket("/ws/{room_id}/{peer_id}")
async def websocket_endpoint(
    websocket: WebSocket,
    room_id: str = Path(
        ...,
        min_length=6,
        max_length=6,
        description="6-character alphanumeric room code"
    ),
    peer_id: str = Path(
        ...,
        min_length=13,
        max_length=13,
        pattern=r"^peer_[a-f0-9\-]+$",
        description="Peer ID starting with 'peer_' followed by an 8-char fragment"
    )
):
    """
    Primary WebSocket endpoint for peers connecting to a synchronized room.

    This acts as the edge router. It delegates the actual `websocket.accept()`,
    connection lifecycle management, wire protocol validation, and message routing
    to `app.core.signaling.handle_websocket` as specified in the blueprint.
    """
    origin = websocket.headers.get("origin")
    if not _origin_allowed(origin):
        logger.warning(f"Rejected WebSocket from disallowed origin: {origin!r}")
        await websocket.close(code=1008, reason="Origin not allowed")
        return

    logger.debug(f"Incoming connection request: Room={room_id}, Peer={peer_id}")

    try:
        # Hand off to the core signaling module (handles WS accept, loop, and closing)
        await handle_websocket(websocket, room_id, peer_id)

    except WebSocketDisconnect as e:
        # Expected client disconnection (e.g., closing tab, leaving room)
        logger.info(f"WebSocket disconnected gracefully: Room={room_id}, Peer={peer_id}, Code={e.code}")

    except Exception as e:
        # Unexpected server-side crashes during the signaling loop
        # Using logger.exception prints the full traceback, critical for debugging
        logger.exception(f"Unexpected error in websocket logic for Room={room_id}, Peer={peer_id}: {e}")
