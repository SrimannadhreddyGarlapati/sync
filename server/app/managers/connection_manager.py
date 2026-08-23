import asyncio
import logging
from typing import Dict, Optional, Tuple

from fastapi import WebSocket

from app.models.room import Room
from app.models.peer import Peer

logger = logging.getLogger("synctube")


class ConnectionManager:
    """
    Manages all WebSocket connections, routing them to the appropriate rooms.
    """
    def __init__(self):
        # Mapping of room_id -> Room object
        self.rooms: Dict[str, Room] = {}

    async def connect(self, websocket: WebSocket, room_id: str, peer_id: str) -> Room:
        """
        Accept a WebSocket connection and add the peer to the requested room.
        Creates the room if it doesn't exist.
        """
        await websocket.accept()
        
        if room_id not in self.rooms:
            logger.info(f"Creating new room: {room_id}")
            self.rooms[room_id] = Room(room_id)
            
        room = self.rooms[room_id]
        peer = Peer(peer_id, websocket)
        
        room.add_peer(peer)
        logger.info(f"Peer {peer_id} joined room {room_id}. Total peers: {len(room.peers)}")
        
        return room

    async def disconnect(self, room_id: str, peer_id: str) -> Tuple[Optional[str], bool]:
        """
        Remove a peer from a room. Cleans up empty rooms.
        Returns a tuple: (new_host_id, is_room_empty)
        """
        if room_id not in self.rooms:
            return None, True
            
        room = self.rooms[room_id]
        new_host_id = room.remove_peer(peer_id)
        
        logger.info(f"Peer {peer_id} left room {room_id}. Total peers: {len(room.peers)}")
        
        if not room.peers:
            logger.info(f"Room {room_id} is empty. Deleting room.")
            del self.rooms[room_id]
            return None, True
            
        return new_host_id, False

    async def broadcast(self, room_id: str, message: dict, exclude_peer_id: Optional[str] = None) -> None:
        """
        Send a JSON message to all peers in a room concurrently, 
        optionally excluding one peer (usually the sender).
        """
        if room_id not in self.rooms:
            return
            
        room = self.rooms[room_id]
        
        # OPTIMIZATION: Fire-and-forget concurrent broadcasting to prevent 
        # a slow peer connection from delaying the broadcast to others.
        tasks = []
        for peer_id, peer in room.peers.items():
            if peer_id == exclude_peer_id:
                continue
            tasks.append(self._safe_send(peer, message))
            
        if tasks:
            await asyncio.gather(*tasks)

    async def send_to_peer(self, room_id: str, target_peer_id: str, message: dict) -> None:
        """
        Send a JSON message to a specific peer in a room.
        Used for WebRTC signaling where offers/answers are targeted.
        """
        if room_id not in self.rooms:
            return
            
        room = self.rooms[room_id]
        peer = room.peers.get(target_peer_id)
        
        if peer:
            await self._safe_send(peer, message)

    async def _safe_send(self, peer: Peer, message: dict) -> None:
        """
        Helper method to isolate send exceptions so they don't crash gather tasks.
        """
        try:
            await peer.send_json(message)
        except Exception as e:
            logger.error(f"Failed to send message to peer {peer.id}: {e}")
            # We do not eagerly disconnect here. The router's WebSocket 
            # Disconnect exception handler will handle the cleanup naturally.

    def get_room(self, room_id: str) -> Optional[Room]:
        """Get a room by ID."""
        return self.rooms.get(room_id)


# Global singleton instance
manager = ConnectionManager()