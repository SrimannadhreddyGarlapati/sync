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


# ---- WebRTC signaling must survive clock validation ------------


@pytest.mark.asyncio
async def test_signaling_is_exempt_from_lamport_validation(wired):
    """
    Regression: SDP and ICE are transport plumbing, sent with lamportClock 0
    because they take no part in the causal ordering. Once a peer had sent any
    real message its clock had advanced, so 0 read as a clock running backwards
    and every offer, answer and candidate was dropped. WebRTC could never
    connect while every other message flowed normally.
    """
    _mgr, room, sockets = wired

    # The peer has been running: heartbeats advanced its Lamport clock.
    for clock in (1, 5, 12, 20):
        await process_message(
            room, "peer_aaaaaaaa",
            _envelope("HEARTBEAT", "peer_aaaaaaaa", clock=clock, videoTime=1.0),
        )
    assert room.peers["peer_aaaaaaaa"].lamport_clock == 20
    sockets["peer_bbbbbbbb"].sent.clear()

    for msg_type, extra in (
        ("SDP_OFFER", {"sdp": {"type": "offer"}}),
        ("SDP_ANSWER", {"sdp": {"type": "answer"}}),
        ("ICE_CANDIDATE", {"candidate": {"candidate": "host"}}),
    ):
        await process_message(
            room, "peer_aaaaaaaa",
            _envelope(msg_type, "peer_aaaaaaaa", clock=0,
                      targetPeerId="peer_bbbbbbbb", **extra),
        )

    delivered = [m["type"] for m in sockets["peer_bbbbbbbb"].sent]
    assert delivered == ["SDP_OFFER", "SDP_ANSWER", "ICE_CANDIDATE"]


@pytest.mark.asyncio
async def test_signaling_exemption_does_not_disturb_the_peer_clock(wired):
    """The exemption must not let clock 0 reset the peer's tracked value."""
    _mgr, room, _sockets = wired
    await process_message(
        room, "peer_aaaaaaaa",
        _envelope("HEARTBEAT", "peer_aaaaaaaa", clock=30, videoTime=1.0),
    )

    await process_message(
        room, "peer_aaaaaaaa",
        _envelope("SDP_OFFER", "peer_aaaaaaaa", clock=0,
                  targetPeerId="peer_bbbbbbbb", sdp={"type": "offer"}),
    )

    assert room.peers["peer_aaaaaaaa"].lamport_clock == 30


@pytest.mark.asyncio
async def test_playback_commands_are_still_clock_validated(wired):
    """The exemption is narrow: it must not weaken the check for real commands."""
    _mgr, room, sockets = wired
    room.peers["peer_aaaaaaaa"].adopt_clock(50)
    sockets["peer_bbbbbbbb"].sent.clear()

    await process_message(
        room, "peer_aaaaaaaa",
        _envelope("PLAY", "peer_aaaaaaaa", clock=0, videoTime=1.0),
    )

    assert sockets["peer_bbbbbbbb"].sent == []


@pytest.mark.asyncio
async def test_signaling_keeps_the_peer_alive_for_the_reaper(wired):
    """A peer mid-negotiation is active, and must not be reaped as silent."""
    import time
    _mgr, room, _sockets = wired
    room.peers["peer_aaaaaaaa"].last_heartbeat = time.time() - 999

    await process_message(
        room, "peer_aaaaaaaa",
        _envelope("ICE_CANDIDATE", "peer_aaaaaaaa", clock=0,
                  targetPeerId="peer_bbbbbbbb", candidate={"candidate": "host"}),
    )

    assert room.peers["peer_aaaaaaaa"].is_stale(45.0) is False


# ---- Liveness while the room runs over P2P ---------------------


@pytest.mark.asyncio
async def test_keepalive_refreshes_liveness_without_being_relayed(wired):
    """
    Regression: once a room is on WebRTC every playback message travels on the
    DataChannel, so the server sees nothing at all on that peer's WebSocket —
    indistinguishable from a dead connection. The reaper then closed the socket
    of a perfectly healthy peer, and reaping the last one deleted the room along
    with the position everyone resyncs to, restarting the video from zero.
    """
    import time
    _mgr, room, sockets = wired
    room.peers["peer_aaaaaaaa"].last_heartbeat = time.time() - 999
    assert room.peers["peer_aaaaaaaa"].is_stale(45.0) is True

    await process_message(room, "peer_aaaaaaaa", {
        "type": "KEEPALIVE",
        "roomId": "ABC123",
        "senderId": "peer_aaaaaaaa",
        "payload": {"hasActiveTab": True, "originTimestamp": 1},
    })

    assert room.peers["peer_aaaaaaaa"].is_stale(45.0) is False
    assert sockets["peer_bbbbbbbb"].sent == [], "no other peer has any use for it"
    assert sockets["peer_cccccccc"].sent == []


@pytest.mark.asyncio
async def test_keepalive_carries_no_clock_and_is_never_rejected(wired):
    """
    It has no lamportClock on purpose: the peer's real clock advanced over the
    DataChannel, which the server never saw, so any value would look like a jump.
    """
    _mgr, room, _sockets = wired
    room.peers["peer_aaaaaaaa"].adopt_clock(500)

    await process_message(room, "peer_aaaaaaaa", {
        "type": "KEEPALIVE",
        "roomId": "ABC123",
        "senderId": "peer_aaaaaaaa",
        "payload": {"hasActiveTab": True},
    })

    assert room.peers["peer_aaaaaaaa"].is_stale(45.0) is False
    assert room.peers["peer_aaaaaaaa"].lamport_clock == 500, "clock left untouched"


@pytest.mark.asyncio
async def test_keepalive_updates_tab_eligibility_for_host_election(wired):
    _mgr, room, _sockets = wired
    assert room.peers["peer_aaaaaaaa"].has_active_tab is False

    await process_message(room, "peer_aaaaaaaa", {
        "type": "KEEPALIVE",
        "roomId": "ABC123",
        "senderId": "peer_aaaaaaaa",
        "payload": {"hasActiveTab": True},
    })

    assert room.peers["peer_aaaaaaaa"].has_active_tab is True


@pytest.mark.asyncio
async def test_a_keepalive_run_survives_the_reaper():
    """End to end: a peer that only sends keepalives is never reaped."""
    import time
    from app.managers.connection_manager import PEER_STALE_TIMEOUT_S

    mgr = ConnectionManager()
    sock_a = FakeAcceptingSocket("a")
    sock_b = FakeAcceptingSocket("b")
    await mgr.connect(sock_a, "ABC123", "peer_aaaaaaaa")
    await mgr.connect(sock_b, "ABC123", "peer_bbbbbbbb")

    room = mgr.rooms["ABC123"]

    # 15s keepalives across a span far longer than the 45s timeout.
    elapsed = 0.0
    while elapsed < PEER_STALE_TIMEOUT_S * 3:
        elapsed += 15.0
        for peer in room.peers.values():
            peer.touch()
        await mgr._reap_once()

    assert len(mgr.rooms["ABC123"].peers) == 2
    assert sock_a.closed_with is None
    assert sock_b.closed_with is None


# ---- Retained playback position --------------------------------


@pytest.mark.asyncio
async def test_a_vacated_room_remembers_where_it_was():
    """
    A blip that briefly drops everyone used to delete the room, so it reformed
    at 0 and yanked every viewer back to the start of the video.
    """
    mgr = ConnectionManager()
    sock = FakeAcceptingSocket("a")
    await mgr.connect(sock, "ABC123", "peer_aaaaaaaa")

    room = mgr.rooms["ABC123"]
    room.last_known_video_id = "dQw4w9WgXcQ"
    room.last_known_time = 137.5
    room.last_known_state = "paused"
    room.mark_state_observed()

    await mgr.disconnect("ABC123", "peer_aaaaaaaa", sock)
    assert "ABC123" not in mgr.rooms

    rejoined = FakeAcceptingSocket("a2")
    await mgr.connect(rejoined, "ABC123", "peer_aaaaaaaa")

    restored = mgr.rooms["ABC123"]
    assert restored.last_known_video_id == "dQw4w9WgXcQ"
    assert restored.last_known_time == 137.5
    assert restored.last_known_state == "paused"


@pytest.mark.asyncio
async def test_a_long_abandoned_room_starts_fresh():
    import time
    from app.managers.connection_manager import ROOM_STATE_GRACE_S

    mgr = ConnectionManager()
    sock = FakeAcceptingSocket("a")
    await mgr.connect(sock, "ABC123", "peer_aaaaaaaa")
    mgr.rooms["ABC123"].last_known_video_id = "vid"
    mgr.rooms["ABC123"].last_known_time = 99.0
    await mgr.disconnect("ABC123", "peer_aaaaaaaa", sock)

    # Someone reusing the code hours later is a different viewing session.
    stamp, snapshot = mgr._retained_state["ABC123"]
    mgr._retained_state["ABC123"] = (stamp - ROOM_STATE_GRACE_S - 60, snapshot)

    await mgr.connect(FakeAcceptingSocket("b"), "ABC123", "peer_bbbbbbbb")

    assert mgr.rooms["ABC123"].last_known_time == 0.0
    assert mgr.rooms["ABC123"].last_known_video_id is None


@pytest.mark.asyncio
async def test_retained_snapshots_are_eventually_dropped():
    from app.managers.connection_manager import ROOM_STATE_GRACE_S

    mgr = ConnectionManager()
    sock = FakeAcceptingSocket("a")
    await mgr.connect(sock, "ABC123", "peer_aaaaaaaa")
    mgr.rooms["ABC123"].last_known_video_id = "vid"
    await mgr.disconnect("ABC123", "peer_aaaaaaaa", sock)
    assert "ABC123" in mgr._retained_state

    stamp, snapshot = mgr._retained_state["ABC123"]
    mgr._retained_state["ABC123"] = (stamp - ROOM_STATE_GRACE_S - 60, snapshot)
    mgr._expire_retained_state()

    assert mgr._retained_state == {}, "snapshots must not accumulate forever"
