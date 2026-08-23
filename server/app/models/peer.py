import time
from fastapi import WebSocket

class Peer:
    """
    Represents a connected client in a room.
    """
    def __init__(self, peer_id: str, websocket: WebSocket):
        self.id = peer_id
        self.websocket = websocket
        self.lamport_clock = None
        self.has_active_tab = False
        self.last_heartbeat = time.time()
        
    def update_state(self, clock: int, has_tab: bool) -> None:
        """
        Syncs internal clock and active tab status based on incoming messages.
        Updates the heartbeat timestamp to prevent timeout disconnects.
        """
        # Strictly monotonically increase the Lamport clock
        if clock > self.lamport_clock:
            self.lamport_clock = clock
            
        self.has_active_tab = has_tab
        self.last_heartbeat = time.time()
        
    async def send_json(self, data: dict) -> None:
        """Send a JSON message to this peer via WebSocket."""
        # Exception handling (e.g., WebSocketDisconnect or RuntimeError) 
        # is assumed to be handled gracefully by the ConnectionManager.
        await self.websocket.send_json(data)