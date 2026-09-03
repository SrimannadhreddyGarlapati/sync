"""Message-routing and connection-lifecycle regression tests."""

import pytest

from app.core.signaling import process_message
from app.managers.connection_manager import ConnectionManager
from app.models.room import Room

from tests.test_room import FakeSocket, _peer


def _envelope(msg_type: str, sender: str, clock: int = 1, **payload) -> dict:
    return {
        "type": msg_type,
        "roomId": "ABC123",
        "senderId": sender,
        "lamportClock": clock,
        "payload": payload,
    }


@pytest.fixture
def wired(monkeypatch):
    """A three-peer room wired to a fresh manager instance."""
    mgr = ConnectionManager()
    room = Room("ABC123")
    mgr.rooms["ABC123"] = room

    sockets = {}
    for pid in ("peer_aaaaaaaa", "peer_bbbbbbbb", "peer_cccccccc"):
        sock = FakeSocket(pid)
        sockets[pid] = sock
        room.add_peer(_peer(pid, sock))

    # process_message reaches for the module-level singleton.
    monkeypatch.setattr("app.core.signaling.manager", mgr)
    return mgr, room, sockets


@pytest.mark.asyncio
async def test_pong_is_unicast_to_the_pinger_only(wired):
    """
    Regression: PONG used to be broadcast to the whole room. A PONG carries the
    pinger's originTimestamp, so every other peer computed
    `now - someone_else's_clock` and fed that into its RTT average, corrupting
    latency compensation for everyone but the pinger.
    """
    _mgr, room, sockets = wired

    await process_message(
        room,
        "peer_aaaaaaaa",
        _envelope(
            "PONG",
            "peer_aaaaaaaa",
            targetPeerId="peer_bbbbbbbb",
            pingOriginTimestamp=1234567890,
        ),
    )

    assert len(sockets["peer_bbbbbbbb"].sent) == 1
    assert sockets["peer_bbbbbbbb"].sent[0]["type"] == "PONG"
    assert sockets["peer_cccccccc"].sent == [], "PONG must not reach unrelated peers"
    assert sockets["peer_aaaaaaaa"].sent == [], "PONG must not echo to the sender"


@pytest.mark.asyncio
async def test_play_is_broadcast_to_everyone_but_the_sender(wired):
    _mgr, room, sockets = wired

    await process_message(room, "peer_aaaaaaaa", _envelope("PLAY", "peer_aaaaaaaa", videoTime=42.0))

    assert len(sockets["peer_bbbbbbbb"].sent) == 1
    assert len(sockets["peer_cccccccc"].sent) == 1
    assert sockets["peer_aaaaaaaa"].sent == []


@pytest.mark.asyncio
async def test_sdp_offer_is_routed_to_target_only(wired):
    _mgr, room, sockets = wired

    await process_message(
        room,
        "peer_aaaaaaaa",
        _envelope("SDP_OFFER", "peer_aaaaaaaa", targetPeerId="peer_cccccccc", sdp={"type": "offer"}),
    )

    assert len(sockets["peer_cccccccc"].sent) == 1
    assert sockets["peer_bbbbbbbb"].sent == []


@pytest.mark.asyncio
async def test_negative_video_time_is_clamped_before_relay(wired):
    _mgr, room, sockets = wired

    await process_message(room, "peer_aaaaaaaa", _envelope("SEEK", "peer_aaaaaaaa", videoTime=-99.0))

    assert sockets["peer_bbbbbbbb"].sent[0]["payload"]["videoTime"] == 0.0


@pytest.mark.asyncio
async def test_malformed_video_time_drops_the_message(wired):
    _mgr, room, sockets = wired

    await process_message(room, "peer_aaaaaaaa", _envelope("SEEK", "peer_aaaaaaaa", videoTime="banana"))

    assert sockets["peer_bbbbbbbb"].sent == []


@pytest.mark.asyncio
async def test_first_clock_is_adopted_without_validation(wired):
    """
    A peer reconnecting after a service-worker restart resumes from a clock it
    persisted, so its first value is arbitrary and must not be rejected as a
    malicious jump.
    """
    _mgr, room, sockets = wired

    await process_message(room, "peer_aaaaaaaa", _envelope("PLAY", "peer_aaaaaaaa", clock=5000, videoTime=1.0))

    assert room.peers["peer_aaaaaaaa"].lamport_clock == 5000
    assert len(sockets["peer_bbbbbbbb"].sent) == 1, "first message must not be dropped"


@pytest.mark.asyncio
async def test_clock_jump_is_rejected_once_a_baseline_exists(wired):
    _mgr, room, sockets = wired
    room.peers["peer_aaaaaaaa"].adopt_clock(10)

    await process_message(room, "peer_aaaaaaaa", _envelope("PLAY", "peer_aaaaaaaa", clock=99999, videoTime=1.0))

    assert sockets["peer_bbbbbbbb"].sent == []
    assert room.peers["peer_aaaaaaaa"].lamport_clock == 10


@pytest.mark.asyncio
async def test_backwards_clock_is_rejected(wired):
    _mgr, room, sockets = wired
    room.peers["peer_aaaaaaaa"].adopt_clock(50)

    await process_message(room, "peer_aaaaaaaa", _envelope("PLAY", "peer_aaaaaaaa", clock=20, videoTime=1.0))

    assert sockets["peer_bbbbbbbb"].sent == []


@pytest.mark.asyncio
async def test_heartbeat_updates_room_state_cache(wired):
    _mgr, room, _sockets = wired

    await process_message(
        room,
        "peer_aaaaaaaa",
        _envelope("HEARTBEAT", "peer_aaaaaaaa", videoTime=77.5, videoId="dQw4w9WgXcQ", isPaused=False),
    )

    assert room.last_known_time == 77.5
    assert room.last_known_video_id == "dQw4w9WgXcQ"
    assert room.last_known_state == "playing"


# ---- Connection lifecycle -------------------------------------


class FakeAcceptingSocket(FakeSocket):
    async def accept(self) -> None:
        pass


@pytest.mark.asyncio
async def test_reconnect_does_not_let_stale_socket_evict_live_peer():
    """
    Regression: the MV3 service worker is killed on idle and reconnects with the
    same peer_id. add_peer overwrote the entry with the new socket, then the old
    socket's finally-block called disconnect(room, peer_id) and deleted the
    *live* entry, silently dropping a connected peer out of the room.
    """
    mgr = ConnectionManager()
    old_socket = FakeAcceptingSocket("old")
    new_socket = FakeAcceptingSocket("new")

    await mgr.connect(old_socket, "ABC123", "peer_aaaaaaaa")
    await mgr.connect(new_socket, "ABC123", "peer_aaaaaaaa")

    # The superseded socket is closed so its handler unwinds promptly.
    assert old_socket.closed_with == 1012

    # Its teardown must be a no-op for the room.
    new_host_id, is_empty = await mgr.disconnect("ABC123", "peer_aaaaaaaa", old_socket)

    assert (new_host_id, is_empty) == (None, False)
    assert "peer_aaaaaaaa" in mgr.rooms["ABC123"].peers
    assert mgr.rooms["ABC123"].peers["peer_aaaaaaaa"].websocket is new_socket


@pytest.mark.asyncio
async def test_disconnect_with_matching_socket_removes_peer():
    mgr = ConnectionManager()
    sock_a = FakeAcceptingSocket("a")
    sock_b = FakeAcceptingSocket("b")

    await mgr.connect(sock_a, "ABC123", "peer_aaaaaaaa")
    await mgr.connect(sock_b, "ABC123", "peer_bbbbbbbb")

    new_host_id, is_empty = await mgr.disconnect("ABC123", "peer_aaaaaaaa", sock_a)

    assert is_empty is False
    assert new_host_id == "peer_bbbbbbbb", "host must migrate when the host leaves"
    assert "peer_aaaaaaaa" not in mgr.rooms["ABC123"].peers


@pytest.mark.asyncio
async def test_last_peer_leaving_deletes_the_room():
    mgr = ConnectionManager()
    sock = FakeAcceptingSocket("a")

    await mgr.connect(sock, "ABC123", "peer_aaaaaaaa")
    new_host_id, is_empty = await mgr.disconnect("ABC123", "peer_aaaaaaaa", sock)

    assert (new_host_id, is_empty) == (None, True)
    assert "ABC123" not in mgr.rooms


@pytest.mark.asyncio
async def test_reaper_removes_silent_peers_and_migrates_host():
    import time

    mgr = ConnectionManager()
    sock_a = FakeAcceptingSocket("a")
    sock_b = FakeAcceptingSocket("b")

    await mgr.connect(sock_a, "ABC123", "peer_aaaaaaaa")
    await mgr.connect(sock_b, "ABC123", "peer_bbbbbbbb")

    # Host's socket died without a close frame.
    mgr.rooms["ABC123"].peers["peer_aaaaaaaa"].last_heartbeat = time.time() - 999

    await mgr._reap_once()

    room = mgr.rooms["ABC123"]
    assert "peer_aaaaaaaa" not in room.peers
    assert room.host_id == "peer_bbbbbbbb"

    types_sent = [m["type"] for m in sock_b.sent]
    assert "LEAVE" in types_sent
    assert "HOST_CHANGE" in types_sent


@pytest.mark.asyncio
async def test_reaper_leaves_live_peers_alone():
    mgr = ConnectionManager()
    sock = FakeAcceptingSocket("a")
    await mgr.connect(sock, "ABC123", "peer_aaaaaaaa")

    await mgr._reap_once()

    assert "peer_aaaaaaaa" in mgr.rooms["ABC123"].peers
