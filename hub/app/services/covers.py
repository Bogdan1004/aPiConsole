"""Box art for ROMs you add yourself, from the libretro-thumbnails project (the art RetroArch shows).

Matching is by file name, so ROMs named like the No-Intro sets ("Tetris (World) (Rev 1).gb") get art.
Downloads run in the background; a miss is remembered so it isn't retried on every library scan.
"""

import logging
import re
import threading
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Callable

log = logging.getLogger("apistation.covers")

THUMBS = "https://thumbnails.libretro.com"
SYSTEMS = {
    "nes": "Nintendo - Nintendo Entertainment System",
    "snes": "Nintendo - Super Nintendo Entertainment System",
    "gb": "Nintendo - Game Boy",
    "gbc": "Nintendo - Game Boy Color",
    "gba": "Nintendo - Game Boy Advance",
    "md": "Sega - Mega Drive - Genesis",
    "sms": "Sega - Master System - Mark III",
    "gg": "Sega - Game Gear",
    "nds": "Nintendo - Nintendo DS",
    "psx": "Sony - PlayStation",
    "n64": "Nintendo - Nintendo 64",
}
SAFE_NAME = re.compile(r"^[a-z0-9._-]+\.png$")


class BoxArt:
    def __init__(self, folder: Path, on_new: Callable[[], None]):
        self.folder = folder
        self.on_new = on_new
        self._pending: set[str] = set()
        self._lock = threading.Lock()

    def path(self, name: str) -> Path | None:
        if not SAFE_NAME.match(name):
            return None
        p = self.folder / name
        return p if p.is_file() else None

    def cover_for(self, game_id: str, folder: str, rom_stem: str) -> str | None:
        """URL of the cached box art, or None while it is being fetched (or if there is none)."""
        if (self.folder / f"{game_id}.png").is_file():
            return f"/api/covers/{game_id}.png"
        if (self.folder / f"{game_id}.none").exists() or folder not in SYSTEMS:
            return None
        with self._lock:
            if game_id in self._pending:
                return None
            self._pending.add(game_id)
        threading.Thread(target=self._fetch, args=(game_id, folder, rom_stem), daemon=True).start()
        return None

    def _fetch(self, game_id: str, folder: str, rom_stem: str) -> None:
        # libretro-thumbnails replaces these characters with "_" in file names.
        name = re.sub(r'[&*/:`<>?\\|"]', "_", rom_stem)
        url = f"{THUMBS}/{urllib.parse.quote(SYSTEMS[folder])}/Named_Boxarts/{urllib.parse.quote(name)}.png"
        self.folder.mkdir(parents=True, exist_ok=True)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "aPiStation"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                (self.folder / f"{game_id}.png").write_bytes(resp.read())
            self.on_new()
        except urllib.error.HTTPError as exc:
            log.info("No box art for %s (%s)", rom_stem, exc.code)
            if exc.code == 404:
                (self.folder / f"{game_id}.none").touch()
        except OSError as exc:  # offline: try again on a later scan
            log.info("Box art lookup failed for %s: %s", rom_stem, exc)
        finally:
            with self._lock:
                self._pending.discard(game_id)
