"""
Measure where sync latency actually goes.

Connects two synthetic peers to a live room and times the same message paths the
extension uses. Both peers run in this one process, so every timestamp comes
from a single clock and no clock-offset correction is needed — which is exactly
why the app measures a round trip rather than differencing two machines' clocks.

What it separates:

  handshake  TCP + TLS + HTTP upgrade to open the socket
  one-way    sender -> server -> receiver, the path a PLAY command takes
  round trip sender -> server -> host -> server -> sender, what PING/PONG times

Anything the extension reports above `round trip` is overhead inside the
extension (service-worker wake-up, chrome.runtime message passing), not network.

Usage:
    PYTHONPATH=. python tools/latency_probe.py [--url wss://host] [--samples 20]
"""

import argparse
import asyncio
import json
import statistics
import time
from typing import Optional

try:
    import websockets
except ImportError:
    raise SystemExit("pip install websockets")


DEFAULT_URL = "wss://sync-l5pk.onrender.com"
ROOM = "PROBE1"
HOST_PEER = "peer_a0000001"     # sorts lower, so it is elected host first
CLIENT_PEER = "peer_b0000002"


def now_ms() -> float:
    return time.time() * 1000


class Peer:
    """A synthetic peer speaking the SyncTube wire protocol."""

    def __init__(self, base_url: str, peer_id: str):
        self.url = f"{base_url}/ws/{ROOM}/{peer_id}"
        self.id = peer_id
        self.socket = None
        self.clock = 0
        self.handshake_ms: Optional[float] = None

    async def connect(self) -> None:
        started = now_ms()
        self.socket = await websockets.connect(self.url, open_timeout=90)
        self.handshake_ms = now_ms() - started

    async def send(self, msg_type: str, payload: dict) -> None:
        # The clock must advance or the server rejects the message as a
        # backwards jump. Signaling is the documented exception.
        self.clock += 1
        await self.socket.send(json.dumps({
            "type": msg_type,
            "roomId": ROOM,
            "senderId": self.id,
            "lamportClock": self.clock,
            "payload": payload,
        }))

    async def recv(self, wanted: str, timeout: float = 15.0) -> dict:
        """Read until a message of the wanted type arrives."""
        deadline = time.time() + timeout
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                raise asyncio.TimeoutError(f"no {wanted} within {timeout}s")
            raw = await asyncio.wait_for(self.socket.recv(), timeout=remaining)
            message = json.loads(raw)
            if message.get("type") == wanted:
                return message

    async def close(self) -> None:
        if self.socket:
            await self.socket.close()


def summarise(label: str, samples: list[float], unit: str = "ms") -> None:
    if not samples:
        print(f"  {label:<28} no samples")
        return

    ordered = sorted(samples)
    median = statistics.median(ordered)
    print(
        f"  {label:<28} median {median:7.1f}{unit}   "
        f"min {ordered[0]:7.1f}   max {ordered[-1]:7.1f}   n={len(ordered)}"
    )


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default=DEFAULT_URL)
    parser.add_argument("--samples", type=int, default=20)
    args = parser.parse_args()

    print(f"Probing {args.url} (room {ROOM}, {args.samples} samples)\n")

    host = Peer(args.url, HOST_PEER)
    client = Peer(args.url, CLIENT_PEER)

    print("Opening sockets (a cold free-tier instance can take ~60s)...")
    await host.connect()
    await host.recv("ROOM_STATE")

    await client.connect()
    await client.recv("ROOM_STATE")
    await host.recv("JOIN")  # host observes the client arriving

    print(f"  host   handshake {host.handshake_ms:7.1f}ms")
    print(f"  client handshake {client.handshake_ms:7.1f}ms\n")

    one_way: list[float] = []
    round_trip: list[float] = []
    host_turnaround: list[float] = []

    for _ in range(args.samples):
        # --- one way: client -> server -> host -------------------
        sent_at = now_ms()
        await client.send("PING", {"originTimestamp": sent_at, "hasActiveTab": True})

        ping = await host.recv("PING")
        arrived_at = now_ms()
        one_way.append(arrived_at - sent_at)

        # --- host replies, exactly as SyncEngine._handlePing does -
        reply_at = now_ms()
        await host.send("PONG", {
            "targetPeerId": client.id,
            "pingOriginTimestamp": ping["payload"]["originTimestamp"],
        })

        pong = await client.recv("PONG")
        completed_at = now_ms()

        host_turnaround.append(reply_at - arrived_at)
        round_trip.append(completed_at - pong["payload"]["pingOriginTimestamp"])

        await asyncio.sleep(0.15)

    print("Results")
    summarise("one way (client->srv->host)", one_way)
    summarise("host turnaround", host_turnaround)
    summarise("round trip (what PING/PONG measures)", round_trip)

    median_rtt = statistics.median(round_trip)
    print(
        f"\n  The extension halves the round trip for its one-way estimate:"
        f" {median_rtt / 2:.1f}ms"
    )
    print(
        "  It should report roughly the round-trip figure above. A materially\n"
        "  larger number in the popup is extension overhead, not the network."
    )

    await client.close()
    await host.close()


if __name__ == "__main__":
    asyncio.run(main())
