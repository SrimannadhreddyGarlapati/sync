import logging
from typing import Any, Dict
from fastapi import WebSocket, WebSocketDisconnect

from app.managers.connection_manager import manager
from app.models.room import Room

logger = logging.getLogger("synctube")

# Relayed to everyone else in the room.
BROADCAST_TYPES = (
    "PLAY", "PAUSE", "SEEK", "FORCE_SYNC", "ROOM_STATE", "REQUEST_STATE",
    "PING", "HEARTBEAT",
)

# Delivered to exactly one named peer, taken from payload.targetPeerId.
#
# PONG belongs here, not in BROADCAST_TYPES. A PONG carries the *pinger's*
# originTimestamp; broadcasting it means every other peer computes
# `now - someone_else's_clock` and feeds that garbage into its RTT average,
# corrupting latency compensation room-wide.
UNICAST_TYPES = ("SDP_OFFER", "SDP_ANSWER", "ICE_CANDIDATE", "PONG")

# Types whose payload updates the room's cached state for late joiners.
STATE_TYPES = ("ROOM_STATE", "HEARTBEAT", "PLAY", "PAUSE", "SEEK")

# Reject a clock that leaps further than this ahead of the peer's last value.
MAX_CLOCK_DELTA = 100


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
                "peerId": peer_id,
                "peers": list(room.peers.keys()),
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
        # Step 4: Handle disconnect.
        # Passing the socket lets the manager ignore this teardown if the peer
        # has already reconnected on a newer socket.
        new_host_id, is_empty = await manager.disconnect(room_id, peer_id, websocket)

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
    if peer is not None:
        if clock is None:
            peer.touch()
        elif not peer.clock_initialized:
            # First message from this connection. A peer that reconnects after a
            # service-worker restart resumes from a persisted clock, so its first
            # value is arbitrary and cannot be validated against anything.
            peer.adopt_clock(clock)
            peer.update_state(clock, payload.get("hasActiveTab", peer.has_active_tab))
        elif clock - peer.lamport_clock > MAX_CLOCK_DELTA or clock < peer.lamport_clock:
            logger.warning(
                f"[{room.id}] Rejected malicious clock jump from {sender_id}: "
                f"{peer.lamport_clock} -> {clock}"
            )
            return  # Drop the message entirely
        else:
            # State: Update peer clock & tab state (tab state arrives on PING/HEARTBEAT)
            peer.update_state(clock, payload.get("hasActiveTab", peer.has_active_tab))

    # 2. Security: Clamp videoTime to >= 0
    if "videoTime" in payload:
        try:
            v_time = float(payload["videoTime"])
            payload["videoTime"] = max(0.0, v_time)
        except (ValueError, TypeError):
            logger.warning(f"[{room.id}] Dropping message from {sender_id} due to invalid videoTime format")
            return

    logger.debug(f"[{room.id}] {sender_id} -> {msg_type}")

    # 3. Routing
    if msg_type in BROADCAST_TYPES:
        # The modified (clamped) message gets broadcast
        await manager.broadcast(room.id, message, exclude_peer_id=sender_id)

    elif msg_type in UNICAST_TYPES:
        target_peer_id = payload.get("targetPeerId")
        if target_peer_id:
            await manager.send_to_peer(room.id, target_peer_id, message)
        else:
            logger.warning(f"[{room.id}] {msg_type} from {sender_id} missing targetPeerId")

    # 4. State: Update the server's cache for future joiners based on state messages
    if msg_type in STATE_TYPES:
        if "videoTime" in payload:
            room.last_known_time = payload["videoTime"]
            room.mark_state_observed()

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
            "videoTime": room.projected_time(),
            "isPaused": room.last_known_state == "paused",
            "videoId": room.last_known_video_id,
            "peers": peer_ids,
            "hostId": room.host_id
        }
    }
