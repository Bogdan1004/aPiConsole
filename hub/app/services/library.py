"""Movies, music and games. Real backends when configured, demo catalog otherwise."""

import hashlib
import logging
import re
import secrets
import shutil
import time
import urllib.parse
from pathlib import Path

from .. import demo_data
from ..config import Settings
from ..store_catalog import STORE
from .covers import BoxArt
from .http import get_json

log = logging.getLogger("apistation.library")

# Folder under the ROM directory → (platform, libretro cores to try in order, file extensions, EmulatorJS system).
ROM_PLATFORMS = {
    "nes": ("NES", ["nestopia_libretro", "fceumm_libretro", "mesen_libretro"], {"nes", "zip"}, "nes"),
    "snes": ("SNES", ["snes9x_libretro", "bsnes_mercury_performance_libretro"], {"sfc", "smc", "zip"}, "snes"),
    "gb": ("Game Boy", ["gambatte_libretro", "mgba_libretro"], {"gb", "zip"}, "gb"),
    "gbc": ("Game Boy Color", ["gambatte_libretro", "mgba_libretro"], {"gbc", "gb", "zip"}, "gb"),
    "gba": ("Game Boy Advance", ["mgba_libretro", "vba_next_libretro"], {"gba", "zip"}, "gba"),
    "md": ("Mega Drive", ["genesis_plus_gx_libretro", "picodrive_libretro"], {"md", "gen", "bin", "smd", "zip"}, "segaMD"),
    "sms": ("Master System", ["genesis_plus_gx_libretro", "picodrive_libretro"], {"sms", "zip"}, "segaMS"),
    "gg": ("Game Gear", ["genesis_plus_gx_libretro"], {"gg", "zip"}, "segaGG"),
    "nds": ("Nintendo DS", ["desmume_libretro", "melonds_libretro"], {"nds", "zip"}, "nds"),
    "psx": ("PlayStation", ["pcsx_rearmed_libretro", "swanstation_libretro"], {"cue", "chd", "pbp", "m3u"}, None),
    "n64": ("Nintendo 64", ["mupen64plus_next_libretro", "parallel_n64_libretro"], {"z64", "n64", "v64", "zip"}, "n64"),
}
ROM_ART = ["grid", "rings", "orbit", "mountains", "moon", "waves", "sunset"]
CORE_DIRS = [Path("/usr/lib/aarch64-linux-gnu/libretro"), Path("/usr/lib/libretro"),
             Path.home() / ".config/retroarch/cores"]


def _palette(seed: str) -> list[str]:
    h = int(hashlib.sha1(seed.encode()).hexdigest()[:6], 16)
    return [f"hsl({h % 360} 80% 60%)", f"hsl({(h // 360) % 360} 70% 22%)"]


def find_core(folder: str) -> Path | None:
    """First installed libretro core for a ROM folder such as "nes" or "gbc"."""
    platform = ROM_PLATFORMS.get(folder)
    for core in platform[1] if platform else []:
        for d in CORE_DIRS:
            p = d / f"{core}.so"
            if p.is_file():
                return p
    return None


class Library:
    TTL = 60

    def __init__(self, settings: Settings):
        self.s = settings
        self.covers = BoxArt(settings.db_path.parent / "covers", on_new=self.invalidate_games)
        self.extra_movies = None  # set by main: films downloaded from the Movies screen
        self._cache: dict[str, tuple[float, list]] = {}
        self.status = {
            "movies": "jellyfin" if settings.jellyfin_url else "demo",
            "music": "navidrome" if settings.navidrome_url else "demo",
            "games": "local",
        }

    def _cached(self, key: str, loader):
        hit = self._cache.get(key)
        if hit and time.time() - hit[0] < self.TTL:
            return hit[1]
        value = loader()
        self._cache[key] = (time.time(), value)
        return value

    # ---------- movies ----------
    def movies(self) -> list[dict]:
        return self._cached("movies", self._all_movies)

    def _all_movies(self) -> list[dict]:
        """Real downloads first; a demo entry is hidden once the real film with that title is on the Pi."""
        downloads = self.extra_movies() if self.extra_movies else []
        have = {re.sub(r"[^a-z0-9]", "", m["title"].lower()) for m in downloads}
        rest = [m for m in self._load_movies() if re.sub(r"[^a-z0-9]", "", m["title"].lower()) not in have]
        return downloads + rest

    def invalidate_movies(self) -> None:
        self._cache.pop("movies", None)

    def _load_movies(self) -> list[dict]:
        if self.s.jellyfin_url:
            try:
                items = self._jellyfin_movies()
                self.status["movies"] = "jellyfin"
                return items
            except Exception as exc:  # fall back to demo, keep the UI alive
                log.warning("Jellyfin unavailable: %s", exc)
                self.status["movies"] = "jellyfin-error"
        movies = []
        for m in demo_data.MOVIES:
            path = self.s.media_dir / m["file"]
            movies.append({**m, "kind": "movie", "source": "demo",
                           "playable": path.is_file(), "path": str(path) if path.is_file() else None})
        return movies

    def _jellyfin_movies(self) -> list[dict]:
        data = get_json(f"{self.s.jellyfin_url}/Items", {
            "IncludeItemTypes": "Movie", "Recursive": "true", "SortBy": "SortName",
            "Fields": "Overview,Genres,ProductionYear,RunTimeTicks,CommunityRating",
        }, headers={"X-Emby-Token": self.s.jellyfin_api_key})
        out = []
        for i, it in enumerate(data.get("Items", [])):
            mid = it["Id"]
            out.append({
                "id": mid, "kind": "movie", "source": "jellyfin", "title": it.get("Name", "Untitled"),
                "year": it.get("ProductionYear"), "minutes": round((it.get("RunTimeTicks") or 0) / 600_000_000),
                "genres": it.get("Genres", []), "rating": it.get("CommunityRating"),
                "synopsis": it.get("Overview", ""), "art": ROM_ART[i % len(ROM_ART)], "palette": _palette(mid),
                "poster": f"{self.s.jellyfin_url}/Items/{mid}/Images/Primary?maxHeight=600",
                "playable": True,
                "stream": f"{self.s.jellyfin_url}/Videos/{mid}/stream?static=true&api_key={self.s.jellyfin_api_key}",
            })
        return out

    # ---------- music ----------
    def albums(self) -> list[dict]:
        return self._cached("albums", self._load_albums)

    def _subsonic(self, endpoint: str, **params):
        salt = secrets.token_hex(6)
        token = hashlib.md5((self.s.navidrome_password + salt).encode()).hexdigest()
        data = get_json(f"{self.s.navidrome_url}/rest/{endpoint}", {
            "u": self.s.navidrome_user, "t": token, "s": salt, "v": "1.16.1", "c": "apistation", "f": "json",
            **params,
        })
        return data["subsonic-response"]

    def _subsonic_url(self, endpoint: str, **params) -> str:
        salt = secrets.token_hex(6)
        token = hashlib.md5((self.s.navidrome_password + salt).encode()).hexdigest()
        q = urllib.parse.urlencode({
            "u": self.s.navidrome_user, "t": token, "s": salt, "v": "1.16.1", "c": "apistation", **params})
        return f"{self.s.navidrome_url}/rest/{endpoint}?{q}"

    def _load_albums(self) -> list[dict]:
        if self.s.navidrome_url:
            try:
                resp = self._subsonic("getAlbumList2", type="alphabeticalByName", size=200)
                self.status["music"] = "navidrome"
                out = []
                for i, a in enumerate(resp.get("albumList2", {}).get("album", [])):
                    out.append({
                        "id": a["id"], "kind": "album", "source": "navidrome", "title": a.get("name", "Untitled"),
                        "artist": a.get("artist", "Unknown"), "year": a.get("year"), "genre": a.get("genre", ""),
                        "mood": "", "art": ROM_ART[i % len(ROM_ART)], "palette": _palette(a["id"]),
                        "poster": self._subsonic_url("getCoverArt", id=a.get("coverArt", a["id"]), size=600),
                        "tracks": [],
                    })
                return out
            except Exception as exc:
                log.warning("Navidrome unavailable: %s", exc)
                self.status["music"] = "navidrome-error"
        return [{**a, "kind": "album", "source": "demo"} for a in demo_data.ALBUMS]

    def album_streams(self, album: dict) -> list[dict]:
        """Track list with stream URLs for real albums; demo albums are synthesized in the console."""
        if album["source"] != "navidrome":
            return [{"title": t} for t in album.get("tracks", [])]
        songs = self._subsonic("getAlbum", id=album["id"]).get("album", {}).get("song", [])
        return [{"title": s.get("title"), "duration": s.get("duration"),
                 "url": self._subsonic_url("stream", id=s["id"])} for s in songs]

    # ---------- games ----------
    def games(self) -> list[dict]:
        return self._cached("games", self._load_games)

    def invalidate_games(self) -> None:
        self._cache.pop("games", None)

    def _load_games(self) -> list[dict]:
        """Built-in games, games installed from the Store, then any other ROMs in the ROM folder."""
        retroarch = shutil.which("retroarch")
        games = [{**g, "kind": "game", "source": "builtin", "available": True, "web": None} for g in demo_data.GAMES]
        known_roms = set()
        for i, entry in enumerate(STORE):
            inst = entry["install"]
            if inst["type"] == "rom":
                path = self.s.roms_dir / inst["rom"]
                known_roms.add(path.resolve())
                if not path.is_file():
                    continue
                launch = {"type": "retroarch", "rom": inst["rom"]}
                available = bool(retroarch and find_core(inst["rom"].split("/", 1)[0]))
            else:
                if not shutil.which(inst["exec"]):
                    continue
                launch = {"type": "native", "exec": inst["exec"], "args": inst.get("args", [])}
                available = True
            game = {k: v for k, v in entry.items() if k not in ("install", "featured")}
            game.update({"kind": "game", "source": "store", "launch": launch, "available": available, "year": None,
                         "art": ROM_ART[i % len(ROM_ART)], "palette": _palette(entry["id"]),
                         "poster": f"/assets/covers/{entry['id']}.jpg"})
            game["web"] = self._web_play(game)
            games.append(game)

        if self.s.roms_dir.is_dir():
            for folder, (platform, _cores, exts, _web) in ROM_PLATFORMS.items():
                for rom in sorted((self.s.roms_dir / folder).glob("*")) if (self.s.roms_dir / folder).is_dir() else []:
                    if not rom.is_file() or rom.suffix.lower().lstrip(".") not in exts or rom.resolve() in known_roms:
                        continue
                    gid = f"rom-{folder}-" + re.sub(r"[^a-z0-9]+", "-", rom.stem.lower()).strip("-")
                    games.append({
                        "id": gid, "kind": "game", "source": "roms",
                        "title": rom.stem.replace("_", " ").strip(),
                        "platform": platform, "genre": "Retro", "players": None, "year": None,
                        "art": ROM_ART[len(games) % len(ROM_ART)], "palette": _palette(gid),
                        "poster": self.covers.cover_for(gid, folder, rom.stem), "poster_fit": "contain",
                        "launch": {"type": "retroarch", "rom": f"{folder}/{rom.name}"},
                        "description": f"{platform} game from your ROM library.",
                        "available": bool(retroarch and find_core(folder)),
                    })
                    games[-1]["web"] = self._web_play(games[-1])
        return games

    def delete_rom(self, game_id: str) -> bool:
        """Remove a ROM you added yourself (Store games are removed through the Store)."""
        game = self.find("game", game_id)
        if not game or game["source"] != "roms":
            return False
        path = self.rom_path(game_id)
        if path:
            path.unlink()
        self.invalidate_games()
        return True

    def _web_play(self, game: dict) -> dict | None:
        """Browser play (EmulatorJS) for a ROM game: its system and the URL the hub serves the ROM at."""
        launch = game.get("launch", {})
        if launch.get("type") != "retroarch":
            return None
        folder, _, filename = launch["rom"].partition("/")
        system = ROM_PLATFORMS.get(folder, (None, None, None, None))[3]
        if not system or not (self.s.roms_dir / launch["rom"]).is_file():
            return None
        return {"system": system, "url": f"/api/roms/{game['id']}/{urllib.parse.quote(filename)}"}

    def rom_path(self, game_id: str) -> Path | None:
        """Path of a game's ROM, only for games in the library and only inside the ROM folder."""
        game = self.find("game", game_id)
        if not game or game.get("launch", {}).get("type") != "retroarch":
            return None
        root = self.s.roms_dir.resolve()
        path = (root / game["launch"]["rom"]).resolve()
        return path if path.is_relative_to(root) and path.is_file() else None

    # ---------- lookup ----------
    def find(self, kind: str, item_id: str) -> dict | None:
        items = {"movie": self.movies, "album": self.albums, "game": self.games}.get(kind)
        if not items:
            return None
        return next((it for it in items() if it["id"] == item_id), None)

    def catalog_digest(self) -> list[dict]:
        """Compact catalog for prompts: id, kind, title and a few tags."""
        out = []
        for m in self.movies():
            out.append({"id": m["id"], "kind": "movie", "title": m["title"], "tags": m.get("genres", []),
                        "year": m.get("year"), "minutes": m.get("minutes")})
        for a in self.albums():
            out.append({"id": a["id"], "kind": "album", "title": f"{a['title']} — {a['artist']}",
                        "tags": [t for t in (a.get("genre"), a.get("mood")) if t]})
        for g in self.games():
            out.append({"id": g["id"], "kind": "game", "title": g["title"],
                        "tags": [g.get("platform"), g.get("genre")], "players": g.get("players")})
        return out
