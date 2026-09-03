import os


def _csv_env(name: str) -> list[str]:
    """Parse a comma-separated env var into a list of non-empty trimmed values."""
    raw = os.getenv(name, "")
    return [item.strip() for item in raw.split(",") if item.strip()]


class Config:
    # Set to true to enable detailed debug logging
    # Optimized to handle multiple common truthy values for robustness
    DEBUG: bool = os.getenv("DEBUG", "false").lower() in ("true", "1", "t", "yes")

    # Optional Redis settings for future horizontal scaling
    # Added str | None type hint and removed redundant default None argument
    REDIS_URL: str | None = os.getenv("REDIS_URL")

    # ---- WebSocket origin allowlist ----------------------------
    # Chrome sends Origin: chrome-extension://<id> on the WebSocket handshake.
    # Set ALLOWED_EXTENSION_IDS to a comma-separated list of extension IDs to
    # reject sockets from anywhere else. Left empty the server accepts any
    # origin and logs a warning, so a fresh clone works before you know your ID.
    ALLOWED_EXTENSION_IDS: list[str] = _csv_env("ALLOWED_EXTENSION_IDS")

    # ---- Cloudflare Realtime TURN ------------------------------
    # Long-term secret used to mint short-lived per-client TURN credentials.
    # Never shipped to the extension: it calls GET /turn-credentials instead.
    # Unset means the /turn-credentials endpoint returns STUN servers only,
    # which works on the same LAN but fails behind symmetric NAT or CGNAT.
    CLOUDFLARE_TURN_KEY_ID: str | None = os.getenv("CLOUDFLARE_TURN_KEY_ID")
    CLOUDFLARE_TURN_API_TOKEN: str | None = os.getenv("CLOUDFLARE_TURN_API_TOKEN")

    # Lifetime of a minted TURN credential, in seconds.
    TURN_CREDENTIAL_TTL_S: int = int(os.getenv("TURN_CREDENTIAL_TTL_S", "3600"))

    @property
    def turn_enabled(self) -> bool:
        return bool(self.CLOUDFLARE_TURN_KEY_ID and self.CLOUDFLARE_TURN_API_TOKEN)


config = Config()
