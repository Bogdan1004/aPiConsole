"""Movies from the whole internet, Netflix style.

Discovery uses Cinemeta, the public IMDb-based catalog that Stremio uses (no API key); posters and
backdrops come from its image CDN. Downloads come only from Internet Archive and only for films that
are legal to share (see films_catalog). Any other film can be found, rated, put on My List and marked
as watched, but not downloaded. The watched library is kept even after a downloaded file is deleted.
"""

import json
import logging
import queue
import re
import threading
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from difflib import SequenceMatcher
from pathlib import Path
from typing import Callable

from ..config import Settings
from ..db import Database, dumps
from ..films_catalog import CREATIVE_COMMONS, PD_COLLECTIONS, PUBLIC_DOMAIN
from .http import get_json

log = logging.getLogger("apistation.films")

CINEMETA = "https://v3-cinemeta.strem.io"
CATALOGS = "https://cinemeta-catalogs.strem.io"
IMG = "https://images.metahub.space"
ARCHIVE = "https://archive.org"
DEFAULT_GENRES = ["Sci-Fi", "Comedy", "Thriller"]
ACTIVE = ("queued", "running")

SCHEMA = """
CREATE TABLE IF NOT EXISTS film_meta (id TEXT PRIMARY KEY, payload TEXT NOT NULL, fetched_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS film_sources (id TEXT PRIMARY KEY, payload TEXT, checked_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS film_log (
    profile_id TEXT NOT NULL, id TEXT NOT NULL, title TEXT, year INTEGER, genres TEXT NOT NULL DEFAULT '[]',
    rating INTEGER NOT NULL DEFAULT 0, source TEXT, watched_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    PRIMARY KEY (profile_id, id));
CREATE TABLE IF NOT EXISTS film_list (
    profile_id TEXT NOT NULL, id TEXT NOT NULL, title TEXT, year INTEGER, genres TEXT NOT NULL DEFAULT '[]',
    added_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')), PRIMARY KEY (profile_id, id));
CREATE TABLE IF NOT EXISTS film_files (
    id TEXT PRIMARY KEY, title TEXT, year INTEGER, path TEXT NOT NULL, size INTEGER, license TEXT,
    added_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')));
"""


def _year(value) -> int | None:
    m = re.search(r"\d{4}", str(value or ""))
    return int(m.group()) if m else None


def _minutes(runtime) -> int | None:
    m = re.search(r"\d+", str(runtime or ""))
    return int(m.group()) if m else None


def _norm(title: str) -> str:
    t = re.sub(r"[^a-z0-9 ]", "", (title or "").lower()).strip()
    return re.sub(r"^the ", "", t)


def poster(fid: str) -> str:
    return f"{IMG}/poster/small/{fid}/img"


def card(m: dict) -> dict:
    fid = m["id"]
    return {
        "id": fid, "kind": "film", "title": m.get("name") or m.get("title") or "Untitled",
        "year": _year(m.get("releaseInfo") or m.get("year") or m.get("released")),
        "poster": poster(fid), "backdrop": f"{IMG}/background/medium/{fid}/img",
        "genres": m.get("genres") or m.get("genre") or [], "rating": m.get("imdbRating"), "runtime": m.get("runtime"),
    }


def _row_card(row: dict) -> dict:
    """A film_log / film_list row back into a card."""
    return {"id": row["id"], "kind": "film", "title": row["title"], "year": row["year"],
            "poster": poster(row["id"]), "backdrop": f"{IMG}/background/medium/{row['id']}/img",
            "genres": json.loads(row.get("genres") or "[]")}


class Films:
    def __init__(self, settings: Settings, db: Database, on_files_changed: Callable[[], None]):
        self.s = settings
        self.db = db
        self.on_files_changed = on_files_changed
        self._cache: dict[str, tuple[float, object]] = {}
        self._free: list[dict] | None = None
        self.jobs: dict[str, dict] = {}
        self._queue: queue.Queue = queue.Queue()
        self._lock = threading.Lock()
        with db.write() as conn:
            conn.executescript(SCHEMA)
        threading.Thread(target=self._worker, daemon=True, name="film-downloads").start()
        threading.Thread(target=self.free_films, daemon=True, name="free-films").start()

    # ---------- discovery ----------
    def _fetch(self, url: str, ttl: float):
        hit = self._cache.get(url)
        if hit and time.time() - hit[0] < ttl:
            return hit[1]
        data = get_json(url, timeout=20)
        self._cache[url] = (time.time(), data)
        return data

    def search(self, q: str) -> list[dict]:
        q = q.strip()[:80]
        if not q:
            return []
        data = self._fetch(f"{CINEMETA}/catalog/movie/top/search={urllib.parse.quote(q)}.json", 900)
        return [card(m) for m in data.get("metas", []) if str(m.get("id", "")).startswith("tt")]

    def catalog(self, name: str = "top", genre: str | None = None) -> list[dict]:
        extra = f"/genre={urllib.parse.quote(genre)}" if genre else ""
        try:
            data = self._fetch(f"{CATALOGS}/{name}/catalog/movie/{name}{extra}.json", 6 * 3600)
        except Exception as exc:
            log.warning("Catalog %s/%s unavailable: %s", name, genre, exc)
            return []
        return [card(m) for m in data.get("metas", []) if str(m.get("id", "")).startswith("tt")]

    def details(self, fid: str) -> dict | None:
        if not re.fullmatch(r"tt\d{5,10}", fid):
            return None
        row = self.db.one("SELECT payload, fetched_at FROM film_meta WHERE id=?", (fid,))
        if row and time.time() - row["fetched_at"] < 7 * 86400:
            return json.loads(row["payload"])
        try:
            m = get_json(f"{CINEMETA}/meta/movie/{fid}.json", timeout=20).get("meta")
        except Exception as exc:
            log.warning("No details for %s: %s", fid, exc)
            return json.loads(row["payload"]) if row else None
        if not m:
            return None
        info = card(m)
        info.update({
            "description": m.get("description") or "",
            "director": (m.get("director") or [])[:2],
            "cast": (m.get("cast") or [])[:6],
            "logo": f"{IMG}/logo/medium/{fid}/img",
            "trailers": [t["source"] for t in m.get("trailers", []) if t.get("type") == "Trailer" and t.get("source")][:3],
            "country": m.get("country"),
        })
        with self.db.write() as conn:
            conn.execute("INSERT OR REPLACE INTO film_meta(id, payload, fetched_at) VALUES (?,?,?)",
                         (fid, dumps(info), time.time()))
        return info

    def lookup(self, title: str, year: int | None) -> dict | None:
        """Best catalog match for a title (and year, when known)."""
        try:
            results = self.search(title)
        except Exception:
            return None
        want = _norm(title)

        def similarity(c):
            return SequenceMatcher(None, want, _norm(c["title"])).ratio()

        def year_gap(c):
            # Catalog years sometimes follow a later US release, so allow a little drift.
            if year is None:
                return 0
            return abs(c["year"] - year) if c["year"] else 2.5  # unknown year: plausible, but ranked lower

        matches = [c for c in results if similarity(c) >= 0.75 and year_gap(c) <= (3 if similarity(c) == 1 else 2.5)]
        return max(matches, key=lambda c: similarity(c) * 10 - year_gap(c), default=None)

    def free_films(self) -> list[dict]:
        """The legal-to-download list, resolved to catalog entries once and kept in memory."""
        if self._free is None:
            wanted = [(f, "Public domain") for f in PUBLIC_DOMAIN] + [(f, "Creative Commons") for f in CREATIVE_COMMONS]
            with ThreadPoolExecutor(max_workers=4) as pool:
                found = list(pool.map(lambda w: self.lookup(w[0]["title"], w[0]["year"]), wanted))
            self._free = [{**c, "license": label} for c, (_, label) in zip(found, wanted) if c]
        return self._free

    def free_ready(self) -> list[dict]:
        """The free list if already resolved (the first resolution runs in the background)."""
        return self._free or []

    # ---------- legal sources ----------
    def free_source(self, film: dict) -> dict | None:
        """Internet Archive file for a film, only if it is CC-licensed or on the EU-safe public-domain list."""
        row = self.db.one("SELECT payload, checked_at FROM film_sources WHERE id=?", (film["id"],))
        if row and time.time() - row["checked_at"] < 7 * 86400:
            return json.loads(row["payload"]) if row["payload"] else None
        source = None
        try:
            source = self._find_source(film)
        except Exception as exc:
            log.info("Archive lookup failed for %s: %s", film["title"], exc)
            return None
        with self.db.write() as conn:
            conn.execute("INSERT OR REPLACE INTO film_sources(id, payload, checked_at) VALUES (?,?,?)",
                         (film["id"], dumps(source) if source else None, time.time()))
        return source

    def _find_source(self, film: dict) -> dict | None:
        title, year = film["title"], film.get("year")
        def listed(entries):
            return next((p for p in entries
                         if _norm(p["title"]) == _norm(title) and (year is None or abs(p["year"] - year) <= 1)), None)

        # Only the hand-checked lists qualify: uploaders on Internet Archive sometimes tag pirated
        # films with a Creative Commons license, so an archive-side license alone is not trusted.
        pd, cc = listed(PUBLIC_DOMAIN), listed(CREATIVE_COMMONS)
        if not (pd or cc):
            return None
        words = re.sub(r"[^\w\s]", " ", title).strip()
        if pd:
            scope = " OR ".join(f"collection:{c}" for c in PD_COLLECTIONS)
            query, label, note = f"title:({words}) AND mediatype:movies AND ({scope})", "Public domain", pd["note"]
        else:
            query, label, note = f"title:({words}) AND mediatype:movies AND licenseurl:*creativecommons*", "Creative Commons", None
        docs = get_json(f"{ARCHIVE}/advancedsearch.php", {
            "q": query, "fl[]": ["identifier", "title", "year", "licenseurl"], "sort[]": "downloads desc",
            "rows": 8, "output": "json"}, timeout=30)["response"]["docs"]
        docs = [d for d in docs if _norm(d.get("title", "")).startswith(_norm(title)[:12])
                and (year is None or not d.get("year") or abs(_year(d["year"]) - year) <= 1)]
        for doc in docs[:3]:
            meta = get_json(f"{ARCHIVE}/metadata/{doc['identifier']}", timeout=30)
            chosen = self._choose_file(meta.get("files", []))
            if chosen:
                return {"identifier": doc["identifier"], "file": chosen["name"], "size": int(chosen.get("size") or 0),
                        "url": f"{ARCHIVE}/download/{doc['identifier']}/{urllib.parse.quote(chosen['name'])}",
                        "page": f"{ARCHIVE}/details/{doc['identifier']}", "license": label,
                        "note": note or doc.get("licenseurl")}
        return None

    @staticmethod
    def _choose_file(files: list[dict]) -> dict | None:
        mp4 = [f for f in files if f.get("name", "").lower().endswith(".mp4") and int(f.get("size") or 0) > 0]
        for fmt, limit in (("h.264", 1.6e9), ("512Kb MPEG4", 3e9), ("MPEG4", 1.6e9), (None, 1.6e9)):
            pool = [f for f in mp4 if (fmt is None or f.get("format") == fmt) and int(f["size"]) <= limit]
            if pool:
                return max(pool, key=lambda f: int(f["size"]))
        return None

    # ---------- personal library ----------
    def watched(self, pid: str) -> list[dict]:
        rows = self.db.all("SELECT * FROM film_log WHERE profile_id=? ORDER BY watched_at DESC", (pid,))
        return [{**_row_card(r), "rating_given": r["rating"], "watched_at": r["watched_at"], "source": r["source"]} for r in rows]

    def my_list(self, pid: str) -> list[dict]:
        rows = self.db.all("SELECT * FROM film_list WHERE profile_id=? ORDER BY added_at DESC", (pid,))
        return [_row_card(r) for r in rows]

    def mark_watched(self, pid: str, film: dict, rating: int = 0, source: str = "manual") -> None:
        with self.db.write() as conn:
            conn.execute(
                "INSERT INTO film_log(profile_id, id, title, year, genres, rating, source) VALUES (?,?,?,?,?,?,?) "
                "ON CONFLICT(profile_id, id) DO UPDATE SET rating=CASE WHEN excluded.rating != 0 THEN excluded.rating "
                "ELSE film_log.rating END, watched_at=datetime('now', 'localtime')",
                (pid, film["id"], film["title"], film.get("year"), dumps(film.get("genres") or []), rating, source))
            conn.execute("DELETE FROM film_list WHERE profile_id=? AND id=?", (pid, film["id"]))

    def unwatch(self, pid: str, fid: str) -> None:
        with self.db.write() as conn:
            conn.execute("DELETE FROM film_log WHERE profile_id=? AND id=?", (pid, fid))

    def toggle_list(self, pid: str, film: dict) -> bool:
        with self.db.write() as conn:
            if conn.execute("DELETE FROM film_list WHERE profile_id=? AND id=?", (pid, film["id"])).rowcount:
                return False
            conn.execute("INSERT INTO film_list(profile_id, id, title, year, genres) VALUES (?,?,?,?,?)",
                         (pid, film["id"], film["title"], film.get("year"), dumps(film.get("genres") or [])))
            return True

    def favorite_genres(self, pid: str) -> list[str]:
        counts: dict[str, int] = {}
        for row in self.db.all("SELECT genres, rating FROM film_log WHERE profile_id=?", (pid,)):
            for g in json.loads(row["genres"] or "[]"):
                counts[g] = counts.get(g, 0) + (2 if row["rating"] > 0 else -2 if row["rating"] < 0 else 1)
        ranked = [g for g, n in sorted(counts.items(), key=lambda kv: -kv[1]) if n > 0]
        return (ranked + [g for g in DEFAULT_GENRES if g not in ranked])[:3]

    def status(self, pid: str, fid: str) -> dict:
        logged = self.db.one("SELECT rating, watched_at FROM film_log WHERE profile_id=? AND id=?", (pid, fid))
        listed = self.db.scalar("SELECT 1 FROM film_list WHERE profile_id=? AND id=?", (pid, fid))
        return {"watched": logged, "in_list": bool(listed), "local": self.file_path(fid) is not None,
                "job": self.jobs.get(fid)}

    # ---------- downloads ----------
    def file_path(self, fid: str) -> Path | None:
        row = self.db.one("SELECT path FROM film_files WHERE id=?", (fid,))
        if not row:
            return None
        path = Path(row["path"])
        return path if path.is_file() else None

    def local_movies(self) -> list[dict]:
        """Downloaded films in the shape of the local movie library (playable on the TV and in a browser)."""
        out = []
        for row in self.db.all("SELECT * FROM film_files ORDER BY added_at DESC"):
            if not Path(row["path"]).is_file():
                continue
            info = self.details(row["id"]) or {}
            out.append({
                "id": row["id"], "kind": "movie", "source": "download", "imdb_id": row["id"],
                "title": row["title"], "year": row["year"], "genres": info.get("genres", []),
                "minutes": _minutes(info.get("runtime")), "rating": info.get("rating"),
                "synopsis": info.get("description", ""), "art": "moon", "palette": ["#94a3b8", "#0f172a"],
                "poster": poster(row["id"]), "playable": True, "path": row["path"], "license": row["license"],
                "size": row["size"],
            })
        return out

    def enqueue_download(self, film: dict, source: dict, profile_id: str | None) -> dict:
        with self._lock:
            current = self.jobs.get(film["id"])
            if current and current["state"] in ACTIVE:
                return current
            job = {"id": film["id"], "title": film["title"], "state": "queued", "progress": 0.0,
                   "message": "Waiting in line…", "size": source["size"], "profile_id": profile_id, "started": time.time()}
            self.jobs[film["id"]] = job
        self._queue.put((job, film, source))
        return job

    def active_jobs(self) -> list[dict]:
        return [j for j in self.jobs.values() if j["state"] in ACTIVE or time.time() - j.get("finished", 0) < 30]

    def _worker(self) -> None:
        while True:
            job, film, source = self._queue.get()
            job["state"] = "running"
            try:
                safe = re.sub(r"[^\w\- ]", "", film["title"]).strip() or film["id"]
                dest = self.s.media_dir / f"{safe} ({film.get('year') or 'unknown'}).mp4"
                self._download(source["url"], dest, job)
                with self.db.write() as conn:
                    conn.execute("INSERT OR REPLACE INTO film_files(id, title, year, path, size, license) VALUES (?,?,?,?,?,?)",
                                 (film["id"], film["title"], film.get("year"), str(dest), source["size"], source["license"]))
                job.update(state="done", progress=1.0, message="Downloaded")
                self.on_files_changed()
            except Exception as exc:
                log.warning("Download of %s failed: %s", film["title"], exc)
                job.update(state="error", message=str(exc)[:200])
            finally:
                job["finished"] = time.time()

    @staticmethod
    def _download(url: str, dest: Path, job: dict) -> None:
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_suffix(".part")
        req = urllib.request.Request(url, headers={"User-Agent": "aPiStation"})
        with urllib.request.urlopen(req, timeout=60) as resp, open(tmp, "wb") as out:
            total = int(resp.headers.get("Content-Length") or job.get("size") or 0)
            done, started = 0, time.time()
            while chunk := resp.read(256 * 1024):
                out.write(chunk)
                done += len(chunk)
                job["progress"] = done / total if total else 0
                speed = done / max(time.time() - started, 1)
                left = (total - done) / speed if total and speed else 0
                job["message"] = f"{done / 1_048_576:.0f} of {total / 1_048_576:.0f} MB · {int(left // 60)} min left"
        tmp.replace(dest)

    def delete_file(self, fid: str) -> bool:
        path = self.file_path(fid)
        with self.db.write() as conn:
            gone = conn.execute("DELETE FROM film_files WHERE id=?", (fid,)).rowcount
        if path:
            path.unlink(missing_ok=True)
        if gone:
            self.on_files_changed()
        return bool(gone)
