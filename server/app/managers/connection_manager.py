import asyncio
import logging
from typing import Dict, List, Optional, Tuple

from fastapi import WebSocket

from app.models.room import Room
from app.models.peer import Peer

logger = logging.getLogger("synctube")

# A peer is considered dead if it sends nothing for this long. Clients send a
# PING or HEARTBEAT every 2s, so this tolerates ~20 consecutive missed messages.
PEER_STALE_TIMEOUT_S = 45.0

# How often the reaper sweeps every room for dead peers.
REAPER_INTERVAL_S = 15.0


class ConnectionManager:
    """
    Manages all WebSocket connections, routing them to the appropriate rooms.
    """
    def __init__(self):
        # Mapping of room_id -> Room object
        self.rooms: Dict[str, Room] = {}
        self._reaper_task: Optional[asyncio.Task] = None

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

        # A peer_id can legitimately reconnect while its previous socket is still
        # half-open: the MV3 service worker is killed on idle and reconnects with
        # the same identity. Close the superseded socket so its handler unwinds
        # promptly instead of lingering and later evicting this live entry.
        previous = room.peers.get(peer_id)
        if previous is not None and previous.websocket is not websocket:
            logger.info(f"Peer {peer_id} reconnected; superseding previous socket")
            await self._close_quietly(previous.websocket)

        peer = Peer(peer_id, websocket)
        room.add_peer(peer)
        logger.info(f"Peer {peer_id} joined room {room_id}. Total peers: {len(room.peers)}")

        return room

    async def disconnect(
        self,
        room_id: str,
        peer_id: str,
        websocket: Optional[WebSocket] = None,
    ) -> Tuple[Optional[str], bool]:
        """
        Remove a peer from a room. Cleans up empty rooms.

        `websocket` identifies which connection is disconnecting. When the same
        peer_id has already reconnected on a newer socket, the stale socket's
        teardown must not evict the live peer, so the removal is skipped.

        Returns a tuple: (new_host_id, is_room_empty)
        """
        if room_id not in self.rooms:
            return None, True

        room = self.rooms[room_id]

        current = room.peers.get(peer_id)
        if websocket is not None and current is not None and current.websocket is not websocket:
            # Superseded socket unwinding after the peer already reconnected.
            logger.debug(f"Ignoring stale disconnect for {peer_id} in room {room_id}")
            return None, False

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
        Used for WebRTC signaling and for PONG replies, where the recipient is
        a single named peer rather than the whole room.
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

    @staticmethod
    async def _close_quietly(websocket: WebSocket) -> None:
        """Close a socket, ignoring the error raised if it is already gone."""
        try:
            await websocket.close(code=1012, reason="Superseded by reconnect")
        except Exception:
            pass

    def get_room(self, room_id: str) -> Optional[Room]:
        """Get a room by ID."""
        return self.rooms.get(room_id)

    # ---- Stale peer reaping ------------------------------------

    def start_reaper(self) -> None:
        """Begin the background sweep for peers whose sockets died silently."""
        if self._reaper_task is None or self._reaper_task.done():
            self._reaper_task = asyncio.create_task(self._reap_loop())
            logger.info("Stale-peer reaper started")

    async def stop_reaper(self) -> None:
        """Cancel the background sweep."""
        if self._reaper_task is not None:
            self._reaper_task.cancel()
            try:
                await self._reaper_task
            except asyncio.CancelledError:
                pass
            self._reaper_task = None

    async def _reap_loop(self) -> None:
        """
        A TCP connection can die without a close frame (laptop sleeps, WiFi drops,
        NAT times out the flow). Without this sweep those peers sit in the room
        forever, inflating room size and holding host status they cannot act on.
        """
        while True:
            try:
                await asyncio.sleep(REAPER_INTERVAL_S)
                await self._reap_once()
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.exception(f"Reaper sweep failed: {e}")

    async def _reap_once(self) -> None:
        """One sweep. Broadcasts LEAVE (and HOST_CHANGE) for each reaped peer."""
        for room_id in list(self.rooms.keys()):
            room = self.rooms.get(room_id)
            if room is None:
                continue

            stale: List[Peer] = [
                peer for peer in room.peers.values()
                if peer.is_stale(PEER_STALE_TIMEOUT_S)
            ]

            for peer in stale:
                logger.info(f"Reaping stale peer {peer.id} from room {room_id}")
                await self._close_quietly(peer.websocket)
                new_host_id, is_empty = await self.disconnect(room_id, peer.id, peer.websocket)

                if is_empty:
                    break

                await self.broadcast(room_id, {
                    "type": "LEAVE",
                    "roomId": room_id,
                    "senderId": peer.id,
                    "lamportClock": 0,
                    "payload": {"peerId": peer.id, "reason": "timeout"},
                })

                if new_host_id:
                    logger.info(f"Host migrated to {new_host_id} in room {room_id} after reap")
                    await self.broadcast(room_id, {
                        "type": "HOST_CHANGE",
                        "roomId": room_id,
                        "senderId": "server",
                        "lamportClock": 0,
                        "payload": {"newHostId": new_host_id, "previousHostId": peer.id},
                    })


# Global singleton instance
manager = ConnectionManager()
