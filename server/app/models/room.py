from typing import Dict, Optional
from app.models.peer import Peer

class Room:
    """
    Represents a room where peers sync their video state.
    Tracks the host/leader and the last known video state.
    """
    def __init__(self, room_id: str):
        self.id = room_id
        # Mapping of peer_id -> Peer object
        self.peers: Dict[str, Peer] = {}
        
        # The ID of the peer currently acting as the host/leader
        self.host_id: Optional[str] = None
        
        # Track the last known state to send to late joiners
        self.last_known_time: float = 0.0
        self.last_known_state: str = "paused"
        self.last_known_video_id: Optional[str] = None

    def add_peer(self, peer: Peer) -> None:
        """Add a peer to the room. Assigns host if room was empty."""
        self.peers[peer.id] = peer
        if self.host_id is None:
            self.host_id = peer.id

    def remove_peer(self, peer_id: str) -> Optional[str]:
        """
        Remove a peer. If the host leaves, elect a new host.
        Returns the ID of the new host, or None if no host change / room is empty.
        """
        if peer_id in self.peers:
            del self.peers[peer_id]
            
        # Re-elect host if the current host was just removed
        if self.host_id == peer_id:
            return self.elect_new_host()
            
        return None

    def elect_new_host(self) -> Optional[str]:
        """
        Elect a new host based on:
        1. Active tab status (Peers with an active video tab are prioritized)
        2. Lamport clock (Highest/most up-to-date state is prioritized)
        
        Fallback to alphabetical sorting of IDs to ensure determinism in ties.
        Returns the new host's ID, or None if the room is empty.
        """
        if not self.peers:
            self.host_id = None
            return None
            
        # Sort using a tuple of negated values for descending priority.
        # -int(p.has_active_tab) ensures True (-1) comes before False (0).
        # -p.lamport_clock ensures higher clocks come first.
        # p.id ensures deterministic tie-breaking (ascending string).
        sorted_peers = sorted(
            self.peers.values(), 
            key=lambda p: (-int(p.has_active_tab), -p.lamport_clock, p.id)
        )
        
        self.host_id = sorted_peers[0].id
        return self.host_id