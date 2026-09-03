import time
from fastapi import WebSocket

class Peer:
    """
    Represents a connected client in a room.
    """
    def __init__(self, peer_id: str, websocket: WebSocket):
        self.id = peer_id
        self.websocket = websocket

        # Starts at 0 rather than None so arithmetic in host election
        # (see Room.elect_new_host) is always well-defined, even for a peer
        # that connected but has not yet sent its first message.
        self.lamport_clock = 0

        # A reconnecting peer resumes from a clock it persisted across a
        # service-worker restart, so the first value it sends is arbitrary.
        # Anti-spoof checks are only meaningful once we have adopted a baseline.
        self.clock_initialized = False

        self.has_active_tab = False
        self.last_heartbeat = time.time()

    def adopt_clock(self, clock: int) -> None:
        """Accept a peer's first reported clock as the baseline, unvalidated."""
        self.lamport_clock = clock
        self.clock_initialized = True

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

    def touch(self) -> None:
        """Refresh the liveness timestamp without altering clock or tab state."""
        self.last_heartbeat = time.time()

    def is_stale(self, timeout_seconds: float) -> bool:
        """True if no message has been received from this peer within the timeout."""
        return (time.time() - self.last_heartbeat) > timeout_seconds

    async def send_json(self, data: dict) -> None:
        """Send a JSON message to this peer via WebSocket."""
        # Exception handling (e.g., WebSocketDisconnect or RuntimeError)
        # is assumed to be handled gracefully by the ConnectionManager.
        await self.websocket.send_json(data)
