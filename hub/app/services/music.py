"""Music from everywhere, YouTube Music style.

Deezer's public API (no key) is the catalog: search, charts, artist pages and artist radio, which keeps the
endless queue going. Songs play in full through YouTube's official embedded player when YOUTUBE_API_KEY is set:
the hub looks up the matching video once per song and remembers it. Without a key, or once the daily YouTube quota
is used up, the console plays Deezer's 30-second previews. Nothing is downloaded; only the listening history is kept.
"""

import html
import json
import logging
import random
import re
import time
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from difflib import SequenceMatcher

from ..config import Settings
from ..db import Database
from .http import get_json

log = logging.getLogger("apistation.music")

DEEZER = "https://api.deezer.com"
YOUTUBE = "https://www.googleapis.com/youtube/v3/search"

SCHEMA = """
CREATE TABLE IF NOT EXISTS music_log (
    profile_id TEXT NOT NULL, id TEXT NOT NULL, title TEXT, artist TEXT, artist_id INTEGER, album TEXT,
    poster TEXT, duration INTEGER, plays INTEGER NOT NULL DEFAULT 0, rating INTEGER NOT NULL DEFAULT 0,
    played_at TEXT, rated_at TEXT, PRIMARY KEY (profile_id, id));
CREATE TABLE IF NOT EXISTS music_videos (id TEXT PRIMARY KEY, videos TEXT NOT NULL, checked_at REAL NOT NULL);
"""

# Words that mark a video as something other than the song itself, unless the song title has them too.
NOT_THE_SONG = ("cover", "karaoke", "remix", "live", "reaction", "8d", "slowed", "sped up", "nightcore",
                "instrumental", "tutorial", "lesson", "piano version", "guitar", "drum")


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]", " ", (text or "").lower())).strip()


def track(t: dict) -> dict:
    album = t.get("album") or {}
    artist = t.get("artist") or {}
    return {
        "id": f"dz{t['id']}", "kind": "track", "title": t.get("title_short") or t.get("title") or "Untitled",
        "artist": artist.get("name") or "", "artist_id": artist.get("id"), "album": album.get("title") or "",
        "poster": album.get("cover_big") or album.get("cover_medium"), "duration": t.get("duration") or 0,
        "explicit": bool(t.get("explicit_lyrics")),
    }


def artist_card(a: dict) -> dict:
    return {"id": f"ar{a['id']}", "kind": "artist", "title": a.get("name") or "", "artist_id": a["id"],
            "poster": a.get("picture_big") or a.get("picture_medium"), "fans": a.get("nb_fan") or 0}


def _row(r: dict) -> dict:
    return {"id": r["id"], "kind": "track", "title": r["title"], "artist": r["artist"], "artist_id": r["artist_id"],
            "album": r["album"], "poster": r["poster"], "duration": r["duration"], "plays": r["plays"],
            "rating_given": r["rating"], "played_at": r["played_at"]}


def _deezer_id(tid: str) -> str:
    if not re.fullmatch(r"dz\d{1,15}", tid or ""):
        raise ValueError(f"Not a Deezer track id: {tid}")
    return tid[2:]


class Music:
    def __init__(self, settings: Settings, db: Database):
        self.db = db
        self.yt_key = settings.youtube_api_key
        self._yt_paused_until = 0.0
        self._cache: dict[str, tuple[float, object]] = {}
        with db.write() as conn:
            conn.executescript(SCHEMA)

    @property
    def full_songs(self) -> bool:
        """True while songs can play in full through YouTube."""
        return bool(self.yt_key) and time.time() >= self._yt_paused_until

    # ---------- Deezer ----------
    def _dz(self, path: str, params: dict | None = None, ttl: float = 3600):
        key = f"{path}?{json.dumps(params or {}, sort_keys=True)}"
        hit = self._cache.get(key)
        if hit and time.time() - hit[0] < ttl:
            return hit[1]
        data = get_json(f"{DEEZER}{path}", params, timeout=10)
        if isinstance(data, dict) and data.get("error"):
            raise RuntimeError(data["error"].get("message") or "Deezer error")
        self._cache[key] = (time.time(), data)
        return data

    def _tracks(self, path: str, params: dict | None = None, ttl: float = 3600) -> list[dict]:
        data = self._dz(path, params, ttl)
        return [track(t) for t in data.get("data", []) if t.get("id") and t.get("readable", True)]

    def search(self, q: str) -> dict:
        q = q.strip()[:80]
        if not q:
            return {"tracks": [], "artists": []}
        tracks = self._tracks("/search", {"q": q, "limit": 40}, 900)
        artists = [artist_card(a) for a in self._dz("/search/artist", {"q": q, "limit": 10}, 900).get("data", [])]
        # Deezer's artist search ranks small namesakes first; the famous one is almost always meant.
        artists.sort(key=lambda a: a["fans"], reverse=True)
        return {"tracks": tracks, "artists": [a for a in artists if a["fans"] >= 500][:8]}

    def chart(self) -> list[dict]:
        return self._tracks("/chart/0/tracks", {"limit": 50}, 6 * 3600)

    def chart_artists(self) -> list[dict]:
        return [artist_card(a) for a in self._dz("/chart/0/artists", {"limit": 20}, 6 * 3600).get("data", [])]

    def artist(self, aid: int) -> dict:
        info = self._dz(f"/artist/{aid}", None, 6 * 3600)
        seen = set()
        top = [t for t in self._tracks(f"/artist/{aid}/top", {"limit": 30}, 6 * 3600)
               if _norm(t["title"]) not in seen and not seen.add(_norm(t["title"]))]
        return {
            "artist": artist_card(info),
            "top": top[:25],
            "related": [artist_card(a) for a in self._dz(f"/artist/{aid}/related", {"limit": 12}, 6 * 3600).get("data", [])],
        }

    def artist_radio(self, aid: int) -> list[dict]:
        """About 25 songs by the artist and similar artists; different on every call."""
        return self._tracks(f"/artist/{aid}/radio", None, 60)

    def find(self, artist: str, title: str) -> dict | None:
        """The catalog song for an artist + title (as Claude names them)."""
        try:
            found = self._tracks("/search", {"q": f"{artist} {title}", "limit": 10}, 24 * 3600)
        except Exception as exc:
            log.warning("Search for %s - %s failed: %s", artist, title, exc)
            return None
        want_title, want_artist = _norm(title), _norm(artist)

        def score(t):
            return (SequenceMatcher(None, want_title, _norm(t["title"])).ratio()
                    + SequenceMatcher(None, want_artist, _norm(t["artist"])).ratio())
        best = max(found, key=score, default=None)
        return best if best and score(best) >= 1.5 else None

    # ---------- endless radio ----------
    def radio(self, pid: str, seed: str, exclude: set[str]) -> list[dict]:
        """The next songs after `seed` (a track or artist id), skipping what was played or disliked."""
        if seed.startswith("ar"):
            aid = int(seed[2:])
        else:
            aid = (self.db.one("SELECT artist_id FROM music_log WHERE id=? AND artist_id IS NOT NULL", (seed,))
                   or {}).get("artist_id")
            if not aid:
                aid = self._dz(f"/track/{_deezer_id(seed)}", None, 24 * 3600)["artist"]["id"]
        skip = exclude | {r["id"] for r in self.db.all(
            "SELECT id FROM music_log WHERE profile_id=? AND rating=-1", (pid,))}
        pool = self.artist_radio(aid)
        related = self._dz(f"/artist/{aid}/related", {"limit": 12}, 6 * 3600).get("data", [])
        for other in random.sample(related, min(2, len(related))):
            pool += self._tracks(f"/artist/{other['id']}/top", {"limit": 5}, 6 * 3600)
        random.shuffle(pool)
        out, names = [], set()
        for t in pool:
            name = (_norm(t["artist"]), _norm(t["title"]))
            if t["id"] in skip or name in names:
                continue
            names.add(name)
            out.append(t)
        # No artist twice in a row.
        for i in range(1, len(out)):
            if out[i]["artist"] == out[i - 1]["artist"]:
                j = next((k for k in range(i + 1, len(out)) if out[k]["artist"] != out[i - 1]["artist"]), None)
                if j:
                    out[i], out[j] = out[j], out[i]
        if seed.startswith("ar"):
            # Asked for this artist: start with one of their songs.
            own = next((i for i, t in enumerate(out) if t.get("artist_id") == aid), None)
            if own:
                out.insert(0, out.pop(own))
        if not out:
            out = [t for t in self.chart() if t["id"] not in skip]
        return out[:15]

    # ---------- playback source ----------
    def source(self, tid: str) -> dict:
        raw = self._dz(f"/track/{_deezer_id(tid)}", None, 1800)
        card = track(raw)
        return {"track": card, "videos": self.videos(card), "preview": raw.get("preview") or None}

    def videos(self, card: dict) -> list[str]:
        """YouTube video ids for a song, best match first (cached; empty without a key)."""
        row = self.db.one("SELECT videos, checked_at FROM music_videos WHERE id=?", (card["id"],))
        if row and (row["videos"] != "[]" or time.time() - row["checked_at"] < 86400):
            return json.loads(row["videos"])
        if not self.full_songs:
            return []
        try:
            data = get_json(YOUTUBE, {
                "part": "snippet", "q": f"{card['artist']} {card['title']}", "type": "video",
                "videoEmbeddable": "true", "videoCategoryId": "10", "maxResults": 6, "key": self.yt_key,
            }, timeout=8)
        except urllib.error.HTTPError as exc:
            if exc.code in (400, 403):
                # Bad key or the daily quota (100 searches) is used up: previews until it resets.
                self._yt_paused_until = time.time() + 3600
                log.warning("YouTube search unavailable (%s), using previews for an hour", exc.code)
            return []
        except Exception as exc:
            log.warning("YouTube search failed: %s", exc)
            return []
        items = [i for i in data.get("items", []) if i.get("id", {}).get("videoId")]
        scored = sorted(((self._video_score(i["snippet"], card), i["id"]["videoId"]) for i in items), reverse=True)
        ids = [vid for score, vid in scored if score > 0][:4]
        with self.db.write() as conn:
            conn.execute("INSERT OR REPLACE INTO music_videos(id, videos, checked_at) VALUES (?,?,?)",
                         (card["id"], json.dumps(ids), time.time()))
        return ids

    @staticmethod
    def _video_score(snippet: dict, card: dict) -> float:
        title = _norm(html.unescape(snippet.get("title", "")))
        channel = _norm(html.unescape(snippet.get("channelTitle", "")))
        song, artist = _norm(card["title"]), _norm(card["artist"])
        score = 0.0
        if snippet.get("channelTitle", "").endswith(" - Topic"):
            score += 4  # YouTube's official audio upload for the release
        if "vevo" in channel:
            score += 3
        if artist and artist in channel:
            score += 3
        if song and song in title:
            score += 3
        if artist and artist in title:
            score += 1
        for word in NOT_THE_SONG:
            if re.search(rf"\b{word}\b", title) and not re.search(rf"\b{word}\b", song):
                score -= 4
        return score

    # ---------- history & ratings ----------
    def _upsert(self, conn, pid: str, t: dict) -> None:
        conn.execute(
            "INSERT INTO music_log(profile_id, id, title, artist, artist_id, album, poster, duration) "
            "VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(profile_id, id) DO UPDATE SET title=excluded.title, "
            "artist=excluded.artist, artist_id=excluded.artist_id, album=excluded.album, poster=excluded.poster, "
            "duration=excluded.duration",
            (pid, t["id"], t["title"], t["artist"], t.get("artist_id"), t.get("album"), t.get("poster"), t.get("duration")))

    def played(self, pid: str, t: dict) -> None:
        with self.db.write() as conn:
            self._upsert(conn, pid, t)
            conn.execute("UPDATE music_log SET plays=plays+1, played_at=datetime('now', 'localtime') "
                         "WHERE profile_id=? AND id=?", (pid, t["id"]))

    def rate(self, pid: str, t: dict, rating: int) -> None:
        with self.db.write() as conn:
            self._upsert(conn, pid, t)
            conn.execute("UPDATE music_log SET rating=?, rated_at=datetime('now', 'localtime') "
                         "WHERE profile_id=? AND id=?", (rating, pid, t["id"]))

    def rating(self, pid: str, tid: str) -> int:
        return self.db.scalar("SELECT rating FROM music_log WHERE profile_id=? AND id=?", (pid, tid)) or 0

    def history(self, pid: str, limit: int = 40) -> list[dict]:
        return [_row(r) for r in self.db.all(
            "SELECT * FROM music_log WHERE profile_id=? AND plays>0 ORDER BY played_at DESC LIMIT ?", (pid, limit))]

    def liked(self, pid: str) -> list[dict]:
        return [_row(r) for r in self.db.all(
            "SELECT * FROM music_log WHERE profile_id=? AND rating=1 ORDER BY rated_at DESC", (pid,))]

    def disliked(self, pid: str) -> list[dict]:
        return [_row(r) for r in self.db.all(
            "SELECT * FROM music_log WHERE profile_id=? AND rating=-1 ORDER BY rated_at DESC", (pid,))]

    def top_artists(self, pid: str, n: int = 3) -> list[dict]:
        """Artists played most, liked songs counting extra."""
        return self.db.all(
            "SELECT artist_id, artist, SUM(plays) + 3 * SUM(rating=1) - 3 * SUM(rating=-1) AS score FROM music_log "
            "WHERE profile_id=? AND artist_id IS NOT NULL GROUP BY artist_id HAVING score > 0 ORDER BY score DESC LIMIT ?",
            (pid, n))

    def home(self, pid: str, albums: list[dict]) -> list[dict]:
        tops = self.top_artists(pid, 2)

        def safe(fn, *args):
            try:
                return fn(*args)
            except Exception as exc:
                log.warning("Music row unavailable: %s", exc)
                return []
        with ThreadPoolExecutor(max_workers=4) as pool:
            chart = pool.submit(safe, self.chart)
            radios = [pool.submit(safe, self.artist_radio, a["artist_id"]) for a in tops]
            artists = pool.submit(safe, lambda: self.artist(tops[0]["artist_id"])["related"] if tops else self.chart_artists())
        rows = [
            {"id": "history", "title": "Recently played", "icon": "clock", "items": self.history(pid)},
            {"id": "liked", "title": "Liked songs", "icon": "heart", "items": self.liked(pid)},
            *({"id": f"more-{a['artist_id']}", "title": f"More like {a['artist']}", "icon": "sparkles",
               "items": r.result()[:20], "seed": f"ar{a['artist_id']}"} for a, r in zip(tops, radios)),
            {"id": "chart", "title": "Top charts", "icon": "flame", "items": chart.result()},
            {"id": "artists", "title": "Artists for you" if tops else "Popular artists", "icon": "users",
             "items": artists.result()},
            {"id": "local", "title": "On your Pi", "icon": "drive", "items": albums},
        ]
        return [r for r in rows if r["items"]]
