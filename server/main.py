import logging
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Path
from fastapi.middleware.cors import CORSMiddleware

from app.core.signaling import handle_websocket
from app.config import config

# Configure logging with comprehensive formatting and module tracking
logging.basicConfig(
    level=logging.DEBUG if config.DEBUG else logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S"
)
logger = logging.getLogger("synctube.main")

# Initialize FastAPI application with OpenAPI metadata
app = FastAPI(
    title="SyncTube Signaling Server",
    description="WebSocket signaling relay and state management for the SyncTube Chrome Extension",
    version="1.0.0"
)

# Configure CORS for HTTP endpoints
# Note: CORSMiddleware strictly applies to HTTP. WebSockets bypass this,
# but we maintain it here for the health check and any future REST endpoints.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # TODO: Restrict to specific chrome-extension://<id> in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/", tags=["Health"])
async def root() -> dict:
    """
    Health check endpoint for load balancers and deployment monitoring.
    Matches the blueprint requirement.
    """
    return {"message": "SyncTube Signaling Server is running!"}

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