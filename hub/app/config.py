"""Runtime settings, read from the environment and an optional hub/.env file."""

import os
from pathlib import Path

HUB_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = HUB_DIR.parent


def _load_dotenv(path: Path) -> None:
    """Minimal .env loader: KEY=VALUE lines, existing env vars win."""
    if not path.is_file():
        return
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_dotenv(HUB_DIR / ".env")


def _flag(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in ("1", "true", "yes", "on")


class Settings:
    # "all" = single Pi; "server" = cloud Pi; "console" = TV Pi
    role = os.getenv("APISTATION_ROLE", "all")
    host = os.getenv("APISTATION_HOST", "0.0.0.0")
    port = int(os.getenv("APISTATION_PORT", "8420"))

    db_path = Path(os.getenv("APISTATION_DB", str(HUB_DIR / "data" / "apistation.db")))
    console_dir = Path(os.getenv("APISTATION_CONSOLE_DIR", str(REPO_DIR / "console")))
    # Cloud Drive (NAS) folder: its own folder, never the whole home folder (that holds hub/.env and the database)
    storage_root = Path(os.getenv("APISTATION_STORAGE", str(Path.home() / "aPiCloud"))).expanduser()
    media_dir = Path(os.getenv("APISTATION_MEDIA", str(Path.home() / "Videos"))).expanduser()
    roms_dir = Path(os.getenv("APISTATION_ROMS", str(Path.home() / "roms"))).expanduser()
    launch_native = _flag("APISTATION_LAUNCH_NATIVE", True)

    # Claude
    anthropic_api_key = os.getenv("ANTHROPIC_API_KEY", "")
    claude_model = os.getenv("APISTATION_CLAUDE_MODEL", "claude-opus-5-5")
    ai_enabled = bool(anthropic_api_key) and _flag("APISTATION_AI", True)
    # Free assistant: llama.cpp server on the Pi (scripts/install-local-llm.sh)
    local_llm_url = os.getenv("APISTATION_LLM_URL", "http://127.0.0.1:8421")

    # Music: full songs through YouTube's embedded player (free key, ~100 new songs a day); previews without it
    youtube_api_key = os.getenv("YOUTUBE_API_KEY", "")

    # Optional real services (empty = demo data)
    jellyfin_url = os.getenv("JELLYFIN_URL", "").rstrip("/")
    jellyfin_api_key = os.getenv("JELLYFIN_API_KEY", "")
    navidrome_url = os.getenv("NAVIDROME_URL", "").rstrip("/")
    navidrome_user = os.getenv("NAVIDROME_USER", "")
    navidrome_password = os.getenv("NAVIDROME_PASSWORD", "")
    homeassistant_url = os.getenv("HOMEASSISTANT_URL", "").rstrip("/")
    homeassistant_token = os.getenv("HOMEASSISTANT_TOKEN", "")


settings = Settings()
