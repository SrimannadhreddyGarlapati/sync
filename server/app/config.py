import os

class Config:
    # Set to true to enable detailed debug logging
    # Optimized to handle multiple common truthy values for robustness
    DEBUG: bool = os.getenv("DEBUG", "false").lower() in ("true", "1", "t", "yes")
    
    # Optional Redis settings for future horizontal scaling
    # Added str | None type hint and removed redundant default None argument
    REDIS_URL: str | None = os.getenv("REDIS_URL")

config = Config()