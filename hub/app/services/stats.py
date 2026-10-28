"""aPi Wrapped: what a player did on the console over a week, a month or all time, how they compare with the other
player, and this week's challenges.

Everything is computed from data the console already keeps: the activity log (every action with its XP and time),
the films watched, each song listened to (music_plays) and the trophies. Challenges change every Monday; finishing
one gives XP once.
"""

import json
import random
from collections import Counter
from datetime import date, datetime, timedelta

from ..db import Database

PERIODS = {"week": 7, "month": 30, "all": None}
CHALLENGE_XP = 100

# id, title, how progress is measured, target
CHALLENGES = [
    ("artists", "Listen to 5 different artists", "distinct_artists", 5),
    ("films", "Watch 2 films", "films", 2),
    ("platforms", "Play games on 2 different platforms", "platforms", 2),
    ("likes", "Like 5 songs", "likes", 5),
    ("assistant", "Ask the assistant 3 things", "ai", 3),
    ("scenes", "Use 3 smart home scenes", "home", 3),
    ("uploads", "Upload 3 files to your Cloud Drive", "upload", 3),
    ("xp", "Earn 300 XP", "xp", 300),
    ("days", "Use aPiStation on 4 different days", "active_days", 4),
    ("songs", "Listen to 20 songs", "songs", 20),
]


def _since(period: str) -> str | None:
    days = PERIODS.get(period)
    if days is None:
        return None
    return (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")


def week_start(today: date | None = None) -> date:
    today = today or date.today()
    return today - timedelta(days=today.weekday())


class Stats:
    def __init__(self, db: Database):
        self.db = db
        with db.write() as conn:
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS music_plays (
                    profile_id TEXT NOT NULL, id TEXT NOT NULL, title TEXT, artist TEXT, artist_id INTEGER,
                    poster TEXT, duration INTEGER, played_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')));
                CREATE INDEX IF NOT EXISTS music_plays_profile ON music_plays(profile_id, played_at);
            """)
            # First run: one listen per song already in the history, at the time it was last played.
            if not conn.execute("SELECT 1 FROM music_plays LIMIT 1").fetchone():
                conn.execute("INSERT INTO music_plays(profile_id, id, title, artist, artist_id, poster, duration, played_at) "
                             "SELECT profile_id, id, title, artist, artist_id, poster, duration, played_at FROM music_log "
                             "WHERE plays > 0 AND played_at IS NOT NULL")

    # ---------- raw numbers ----------
    def _where(self, pid: str, since: str | None, column: str) -> tuple[str, tuple]:
        return (f"profile_id=? AND {column}>=?", (pid, since)) if since else ("profile_id=?", (pid,))

    def numbers(self, pid: str, since: str | None) -> dict:
        w, p = self._where(pid, since, "ts")
        acts = self.db.all(f"SELECT kind, item_id, title, meta, xp, ts FROM activity WHERE {w}", p)
        mw, mp = self._where(pid, since, "played_at")
        plays = self.db.all(f"SELECT * FROM music_plays WHERE {mw}", mp)
        fw, fp = self._where(pid, since, "watched_at")
        films = self.db.all(f"SELECT id, title, year, genres, rating, watched_at FROM film_log WHERE {fw} ORDER BY watched_at DESC", fp)
        lw, lp = self._where(pid, since, "rated_at")
        likes = self.db.scalar(f"SELECT COUNT(*) FROM music_log WHERE rating=1 AND {lw}", lp) or 0
        tw, tp = self._where(pid, since, "unlocked_at")
        trophies = self.db.scalar(f"SELECT COUNT(*) FROM trophies WHERE {tw}", tp) or 0
        kinds = Counter(a["kind"] for a in acts)
        platforms = {json.loads(a["meta"] or "{}").get("platform") for a in acts if a["kind"] == "play"} - {None}
        return {
            "acts": acts, "plays": plays, "films_rows": films,
            "xp": sum(a["xp"] for a in acts),
            "active_days": len({a["ts"][:10] for a in acts}),
            "music_minutes": round(sum(p["duration"] or 0 for p in plays) / 60),
            "songs": len(plays),
            "distinct_artists": len({p["artist"] for p in plays if p["artist"]}),
            "films": len(films),
            "games": kinds["play"],
            "platforms": len(platforms),
            "home": kinds["home"],
            "ai": kinds["ai"],
            "upload": kinds["upload"],
            "likes": likes,
            "trophies": trophies,
        }

    # ---------- the Wrapped page ----------
    def wrapped(self, pid: str, period: str, others: list[dict]) -> dict:
        since = _since(period)
        n = self.numbers(pid, since)
        days = PERIODS[period] or 30  # "all time" shows the last 30 days day by day
        start = date.today() - timedelta(days=days - 1)
        per_day = Counter()
        for a in n["acts"]:
            per_day[a["ts"][:10]] += a["xp"]
        daily = [{"date": (start + timedelta(days=i)).isoformat(), "xp": per_day[(start + timedelta(days=i)).isoformat()]}
                 for i in range(days)]
        heat = [[0] * 24 for _ in range(7)]  # weekday (Mon=0) × hour
        for a in n["acts"]:
            if a["kind"] == "login":
                continue
            t = datetime.fromisoformat(a["ts"])
            heat[t.weekday()][t.hour] += 1
        artists, songs = Counter(), Counter()
        posters, song_info = {}, {}
        for p in n["plays"]:
            if p["artist"]:
                artists[p["artist"]] += 1
                posters.setdefault(p["artist"], p["poster"])
            songs[p["id"]] += 1
            song_info[p["id"]] = {"title": p["title"], "artist": p["artist"], "poster": p["poster"]}
        games = Counter(a["title"] for a in n["acts"] if a["kind"] == "play" and a["title"])
        return {
            "period": period,
            "kpis": {k: n[k] for k in ("xp", "active_days", "music_minutes", "songs", "films", "games", "trophies",
                                       "home", "ai", "upload")},
            "daily": daily,
            "heat": heat,
            "top_artists": [{"name": a, "plays": c, "poster": posters.get(a)} for a, c in artists.most_common(5)],
            "top_songs": [{**song_info[s], "plays": c} for s, c in songs.most_common(5)],
            "films": [{"id": f["id"], "title": f["title"], "year": f["year"], "rating": f["rating"]} for f in n["films_rows"][:6]],
            "top_games": [{"title": t, "plays": c} for t, c in games.most_common(5)],
            "leaderboard": [
                {"id": o["id"], "name": o["name"], "hue": o["hue"],
                 **{k: v for k, v in self.numbers(o["id"], since).items() if k in ("xp", "music_minutes", "films", "games", "trophies")}}
                for o in others
            ],
        }

    # ---------- weekly challenges ----------
    def challenges(self, pid: str) -> tuple[list[dict], list[dict]]:
        """This week's three challenges with progress, and the ones just completed (to reward once)."""
        monday = week_start()
        key = f"{monday.isocalendar().year}-W{monday.isocalendar().week:02d}"
        picks = random.Random(key).sample(CHALLENGES, 3)  # the same three for everyone this week
        n = self.numbers(pid, f"{monday.isoformat()} 00:00:00")
        rewarded = {r["item_id"] for r in self.db.all(
            "SELECT item_id FROM activity WHERE profile_id=? AND kind='challenge' AND item_id LIKE ?", (pid, f"{key}:%"))}
        out, newly = [], []
        for cid, title, measure, target in picks:
            progress = n[measure]
            item_id = f"{key}:{cid}"
            done = progress >= target
            out.append({"id": cid, "title": title, "progress": min(progress, target), "target": target,
                        "done": done, "xp": CHALLENGE_XP, "week": key})
            if done and item_id not in rewarded:
                newly.append({"item_id": item_id, "title": title})
        return out, newly


def offline_story(profile: dict, wrapped: dict) -> dict:
    """A persona and summary without Claude (and always for the Guest)."""
    k = wrapped["kpis"]
    scores = {"Music Explorer": k["songs"], "Cinephile": k["films"] * 4, "Retro Gamer": k["games"] * 2,
              "Smart Home Wizard": k["home"], "Curious Mind": k["ai"]}
    persona = max(scores, key=scores.get) if any(scores.values()) else "Fresh Start"
    hours = [sum(day[h] for day in wrapped["heat"]) for h in range(24)]
    peak = max(range(24), key=lambda h: hours[h]) if any(hours) else None
    if peak is not None and (peak >= 22 or peak < 5):
        persona = f"Night Owl {persona}" if persona != "Fresh Start" else "Night Owl"
    top_artist = wrapped["top_artists"][0]["name"] if wrapped["top_artists"] else None
    facts = [f"{k['music_minutes']} minutes of music" + (f", mostly {top_artist}" if top_artist else ""),
             f"{k['films']} films and {k['games']} game sessions",
             f"{k['xp']} XP earned on {k['active_days']} active days"]
    return {"source": "offline", "persona": persona,
            "headline": f"{profile['name']}, you're a {persona}",
            "summary": f"You were busiest around {peak}:00." if peak is not None else "Your story starts now: play, watch and listen to fill it in.",
            "facts": facts}
