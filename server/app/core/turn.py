"""
ICE server provisioning.

WebRTC needs STUN to discover a peer's public mapping, and TURN to relay when
the two NATs refuse to let a direct path form at all (symmetric NAT, CGNAT,
most mobile networks). STUN is free and anonymous; TURN costs bandwidth and so
requires credentials.

Cloudflare Realtime TURN is used here because its long-term key mints
short-lived credentials over an API. That keeps the long-term secret on the
server: the extension asks this endpoint for an `iceServers` array valid for an
hour, so a leaked credential expires on its own.

Falls back to STUN-only when no key is configured, which is enough for peers on
the same LAN.
"""

import logging
import time
from typing import Any, Dict, List, Optional

import httpx

from app.config import config

logger = logging.getLogger("synctube.turn")

CLOUDFLARE_TURN_API = (
    "https://rtc.live.cloudflare.com/v1/turn/keys/{key_id}/credentials/generate-ice-servers"
)

STUN_ONLY: List[Dict[str, Any]] = [
    {"urls": "stun:stun.l.google.com:19302"},
    {"urls": "stun:stun1.l.google.com:19302"},
]

# Credentials are reused until they are close to expiry rather than minted per
# request, so a room full of peers joining at once makes one upstream call.
_CACHE_SAFETY_MARGIN_S = 300


class _IceCache:
    def __init__(self) -> None:
        self.servers: Optional[List[Dict[str, Any]]] = None
        self.expires_at: float = 0.0

    def get(self) -> Optional[List[Dict[str, Any]]]:
        if self.servers is not None and time.time() < self.expires_at:
            return self.servers
        return None

    def put(self, servers: List[Dict[str, Any]], ttl_s: int) -> None:
        self.servers = servers
        self.expires_at = time.time() + max(0, ttl_s - _CACHE_SAFETY_MARGIN_S)


_cache = _IceCache()


async def get_ice_servers() -> Dict[str, Any]:
    """
    Return an `iceServers` array suitable for passing to RTCPeerConnection.

    Never raises: on any upstream failure it degrades to STUN-only so peers on
    the same network still connect.
    """
    if not config.turn_enabled:
        return {"iceServers": STUN_ONLY, "turn": False}

    cached = _cache.get()
    if cached is not None:
        return {"iceServers": cached, "turn": True, "cached": True}

    ttl = config.TURN_CREDENTIAL_TTL_S
    url = CLOUDFLARE_TURN_API.format(key_id=config.CLOUDFLARE_TURN_KEY_ID)

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.post(
                url,
                headers={"Authorization": f"Bearer {config.CLOUDFLARE_TURN_API_TOKEN}"},
                json={"ttl": ttl},
            )
            response.raise_for_status()
            data = response.json()
    except Exception as e:
        logger.warning(f"TURN credential fetch failed, falling back to STUN-only: {e}")
        return {"iceServers": STUN_ONLY, "turn": False, "error": "turn_unavailable"}

    ice_servers = data.get("iceServers")
    if not ice_servers:
        logger.warning("TURN response contained no iceServers; falling back to STUN-only")
        return {"iceServers": STUN_ONLY, "turn": False, "error": "malformed_turn_response"}

    # Cloudflare returns a single entry; normalise to a list and keep STUN as a
    # cheap first candidate so the direct path is still tried first.
    if isinstance(ice_servers, dict):
        ice_servers = [ice_servers]

    combined = STUN_ONLY + ice_servers
    _cache.put(combined, ttl)

    logger.info("Minted fresh Cloudflare TURN credentials")
    return {"iceServers": combined, "turn": True, "cached": False}
