import logging
from typing import Any, Dict
from fastapi import WebSocket, WebSocketDisconnect

from app.managers.connection_manager import manager
from app.models.room import Room

logger = logging.getLogger("synctube")

async def handle_websocket(websocket: WebSocket, room_id: str, peer_id: str):
    """
    Main WebSocket handler for a connected peer.
    """
    room = await manager.connect(websocket, room_id, peer_id)
    
    try:
        # Step 1: Send initial ROOM_STATE to the joining peer
        # If they are the host, this will just confirm they are host.
        # If they are joining an existing room, this gives them the state.
        room_state_msg = _create_room_state_message(room, room_id)
        await websocket.send_json(room_state_msg)
        
        # Step 2: Broadcast a JOIN event to all other peers in the room
        join_msg = {
            "type": "JOIN",
            "roomId": room_id,
            "senderId": peer_id,
            "lamportClock": 0,
            "payload": {
                "peerId": peer_id
            }
        }
        await manager.broadcast(room_id, join_msg, exclude_peer_id=peer_id)
        
        # Step 3: Listen for incoming messages
        while True:
            data = await websocket.receive_json()
            await process_message(room, peer_id, data)
            
    except WebSocketDisconnect:
        logger.info(f"WebSocket disconnected normally for peer {peer_id} in room {room_id}")
    except Exception as e:
        logger.warning(f"WebSocket connection error for peer {peer_id}: {e}")
    finally:
        # Step 4: Handle disconnect
        new_host_id, is_empty = await manager.disconnect(room_id, peer_id)
        
        if not is_empty:
            # Notify remaining peers that this peer left
            leave_msg = {
                "type": "LEAVE",
                "roomId": room_id,
                "senderId": peer_id,
                "lamportClock": 0, # Server messages don't strictly participate in Lamport ordering
                "payload": {
                    "peerId": peer_id
                }
            }
            await manager.broadcast(room_id, leave_msg)
            
            # If the host left, notify peers of the new host
            if new_host_id:
                logger.info(f"Host migrated to {new_host_id} in room {room_id}")
                host_change_msg = {
                    "type": "HOST_CHANGE",
                    "roomId": room_id,
                    "senderId": "server",
                    "lamportClock": 0,
                    "payload": {
                        "newHostId": new_host_id,
                        "previousHostId": peer_id
                    }
                }
                await manager.broadcast(room_id, host_change_msg)


async def process_message(room: Room, sender_id: str, message: Dict[str, Any]):
    """
    Process an incoming message from a peer.
    Routes sync commands, clock-sync messages, and signaling to the
    appropriate peers in the room.
    """
    msg_type = message.get("type")
    payload = message.get("payload", {})
    clock = message.get("lamportClock")
    
    peer = room.peers.get(sender_id)
    
    # 1. Security & State: Validate Lamport Clock and update Peer state
    if peer and clock is not None:
        # Security: Reject malicious Lamport clock jumps (>100 delta)
        if peer.lamport_clock is None:
            peer.lamport_clock = clock
        elif clock - peer.lamport_clock > 100 or clock < peer.lamport_clock:
            logger.warning(f"[{room.id}] Rejected malicious clock jump from {sender_id}: {peer.lamport_clock} -> {clock}")
            return  # Drop the message entirely
            
        # State: Update peer clock & tab state (tab state usually arrives on HEARTBEAT)
        has_tab = payload.get("hasActiveTab", peer.has_active_tab)
        peer.update_state(clock, has_tab)
        
    # 2. Security: Clamp videoTime to >= 0
    if "videoTime" in payload:
        try:
            v_time = float(payload["videoTime"])
            payload["videoTime"] = max(0.0, v_time)
        except (ValueError, TypeError):
            logger.warning(f"[{room.id}] Dropping message from {sender_id} due to invalid videoTime format")
            return
            
    logger.debug(f"[{room.id}] {sender_id} -> {msg_type}")
    
    # 3. Routing: Relay commands and state updates to other peers in the room
    if msg_type in ("PLAY", "PAUSE", "SEEK", "FORCE_SYNC", "ROOM_STATE", "REQUEST_STATE",
                    "PING", "PONG", "HEARTBEAT"):
        # The modified (clamped) message gets broadcast
        await manager.broadcast(room.id, message, exclude_peer_id=sender_id)
        
    # Route WebRTC signaling messages directly to the target peer
    elif msg_type in ("SDP_OFFER", "SDP_ANSWER", "ICE_CANDIDATE"):
        target_peer_id = payload.get("targetPeerId")
        if target_peer_id:
            await manager.send_to_peer(room.id, target_peer_id, message)
        else:
            logger.warning(f"[{room.id}] {msg_type} from {sender_id} missing targetPeerId")
        
    # 4. State: Update the server's cache for future joiners based on state messages
    if msg_type in ("ROOM_STATE", "HEARTBEAT", "PLAY", "PAUSE", "SEEK"):
        if "videoTime" in payload:
            room.last_known_time = payload["videoTime"]
            
        if msg_type == "PLAY":
            room.last_known_state = "playing"
        elif msg_type == "PAUSE":
            room.last_known_state = "paused"
        elif "isPaused" in payload:
            room.last_known_state = "paused" if payload["isPaused"] else "playing"
            
        if "videoId" in payload:
            room.last_known_video_id = payload["videoId"]


def _create_room_state_message(room: Room, room_id: str) -> dict:
    """Helper to build a ROOM_STATE message."""
    peer_ids = list(room.peers.keys())
    
    return {
        "type": "ROOM_STATE",
        "roomId": room_id,
        "senderId": "server",
        "lamportClock": 0, # Server messages don't strictly participate in Lamport ordering
        "payload": {
            "videoTime": room.last_known_time,
            "isPaused": room.last_known_state == "paused",
            "videoId": room.last_known_video_id,
            "peers": peer_ids,
            "hostId": room.host_id
        }
    }