"""Room state and host-election regression tests."""

import time

import pytest

from app.models.peer import Peer
from app.models.room import Room


class FakeSocket:
    """Stands in for a Starlette WebSocket; records what was sent to it."""

    def __init__(self, name: str = "sock"):
        self.name = name
        self.sent: list[dict] = []
        self.closed_with: int | None = None

    async def send_json(self, data: dict) -> None:
        self.sent.append(data)

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed_with = code


def _peer(peer_id: str, socket: FakeSocket | None = None) -> Peer:
    return Peer(peer_id, socket or FakeSocket(peer_id))


def test_elect_new_host_with_peer_that_never_sent_a_message():
    """
    Regression: Peer.lamport_clock used to default to None, so a peer that
    connected but had not yet sent a message made `-p.lamport_clock` raise
    TypeError inside elect_new_host. That exception fired from the disconnect
    path, so LEAVE and HOST_CHANGE were never broadcast and the room silently
    kept pointing at a host that had gone.
    """
    room = Room("ABC123")
    room.add_peer(_peer("peer_aaaaaaaa"))   # becomes host
    room.add_peer(_peer("peer_bbbbbbbb"))   # never sends anything

    new_host = room.remove_peer("peer_aaaaaaaa")

    assert new_host == "peer_bbbbbbbb"
    assert room.host_id == "peer_bbbbbbbb"


def test_elect_new_host_prefers_peer_with_active_tab():
    room = Room("ABC123")
    room.add_peer(_peer("peer_aaaaaaaa"))
    no_tab = _peer("peer_bbbbbbbb")
    with_tab = _peer("peer_cccccccc")
    with_tab.update_state(5, True)
    no_tab.update_state(99, False)
    room.add_peer(no_tab)
    room.add_peer(with_tab)

    # Active tab outranks the higher Lamport clock.
    assert room.remove_peer("peer_aaaaaaaa") == "peer_cccccccc"


def test_elect_new_host_breaks_clock_ties_deterministically():
    room = Room("ABC123")
    room.add_peer(_peer("peer_aaaaaaaa"))
    for pid in ("peer_dddddddd", "peer_bbbbbbbb", "peer_cccccccc"):
        peer = _peer(pid)
        peer.update_state(7, True)
        room.add_peer(peer)

    assert room.remove_peer("peer_aaaaaaaa") == "peer_bbbbbbbb"


def test_remove_peer_returns_none_when_non_host_leaves():
    room = Room("ABC123")
    room.add_peer(_peer("peer_aaaaaaaa"))
    room.add_peer(_peer("peer_bbbbbbbb"))

    assert room.remove_peer("peer_bbbbbbbb") is None
    assert room.host_id == "peer_aaaaaaaa"


def test_projected_time_advances_while_playing():
    """A late joiner should get the position as of now, not as of the last message."""
    room = Room("ABC123")
    room.last_known_time = 100.0
    room.last_known_state = "playing"
    room.last_state_at = time.time() - 2.0

    projected = room.projected_time()

    assert 101.5 < projected < 102.5


def test_projected_time_frozen_while_paused():
    room = Room("ABC123")
    room.last_known_time = 100.0
    room.last_known_state = "paused"
    room.last_state_at = time.time() - 10.0

    assert room.projected_time() == 100.0


def test_projected_time_ignores_implausibly_long_gaps():
    """A silent host is not a playing host; do not project across a huge gap."""
    room = Room("ABC123")
    room.last_known_time = 100.0
    room.last_known_state = "playing"
    room.last_state_at = time.time() - 600.0

    assert room.projected_time() == 100.0


def test_peer_clock_starts_at_zero_and_is_monotonic():
    peer = _peer("peer_aaaaaaaa")
    assert peer.lamport_clock == 0
    assert peer.clock_initialized is False

    peer.update_state(10, True)
    assert peer.lamport_clock == 10

    peer.update_state(4, True)
    assert peer.lamport_clock == 10, "clock must never move backwards"


def test_peer_staleness_tracking():
    peer = _peer("peer_aaaaaaaa")
    assert peer.is_stale(45.0) is False

    peer.last_heartbeat = time.time() - 60.0
    assert peer.is_stale(45.0) is True

    peer.touch()
    assert peer.is_stale(45.0) is False
