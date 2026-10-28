"""XP, levels, trophies, daily quests and streaks."""

import json
import random
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Callable

from .db import Database, dumps

# Base XP per action kind, and how many rewarded actions per day.
XP_RULES = {
    "login": (5, 1),
    "watch": (40, None),
    "listen": (25, 8),
    "play": (30, None),
    "home": (10, 8),
    "ai": (15, 5),
    "share": (20, 5),
    "score": (0, 3),  # XP comes from the score itself
    "install": (15, 3),
    "upload": (5, 10),
    "challenge": (100, None),
    "rate": (5, 5),
}
# These kinds reward each item only once per day.
ONCE_PER_ITEM = {"watch", "listen", "play"}
CATEGORY_KINDS = {"watch", "listen", "play", "home", "ai"}
TROPHY_XP = {"bronze": 15, "silver": 30, "gold": 60, "platinum": 150}

TITLES = [(1, "Rookie"), (3, "Explorer"), (5, "Curator"), (8, "Cloud Captain"), (12, "Pi Master"), (20, "Pi Legend")]


def xp_threshold(level: int) -> int:
    """Total XP needed to reach `level`."""
    return 0 if level <= 1 else round(100 * (level - 1) ** 1.5)


def level_for(xp: int) -> int:
    level = 1
    while xp >= xp_threshold(level + 1):
        level += 1
    return level


def title_for(level: int) -> str:
    return [name for need, name in TITLES if level >= need][-1]


def next_title(level: int) -> tuple[int, str] | None:
    return next(((need, name) for need, name in TITLES if need > level), None)


@dataclass
class Stats:
    counts: dict[str, int]
    platforms: int
    best_score: int
    streak: int
    level: int
    quests_done: int
    kinds_today: set[str]
    unlocked: set[str] = field(default_factory=set)

    def count(self, kind: str) -> int:
        return self.counts.get(kind, 0)


@dataclass
class Trophy:
    id: str
    name: str
    description: str
    tier: str
    icon: str
    progress: Callable[[Stats], tuple[int, int]]


TROPHIES = [
    Trophy("hello_world", "Hello, World", "Sign in to aPiStation for the first time.", "bronze", "power",
           lambda s: (s.count("login"), 1)),
    Trophy("popcorn", "Popcorn Time", "Watch your first movie.", "bronze", "film",
           lambda s: (s.count("watch"), 1)),
    Trophy("cinephile", "Cinephile", "Watch 10 movies.", "silver", "film",
           lambda s: (s.count("watch"), 10)),
    Trophy("drop_the_beat", "Drop the Beat", "Play your first song or album.", "bronze", "music",
           lambda s: (s.count("listen"), 1)),
    Trophy("audiophile", "Audiophile", "Start music 20 times.", "silver", "music",
           lambda s: (s.count("listen"), 20)),
    Trophy("insert_coin", "Insert Coin", "Launch your first game.", "bronze", "gamepad",
           lambda s: (s.count("play"), 1)),
    Trophy("retro_collector", "Retro Collector", "Play games on 4 different platforms.", "gold", "gamepad",
           lambda s: (s.platforms, 4)),
    Trophy("snake_charmer", "Snake Charmer", "Score 20 points in π Snake.", "silver", "zap",
           lambda s: (s.best_score, 20)),
    Trophy("home_wizard", "Home Wizard", "Control your smart home 5 times.", "bronze", "home",
           lambda s: (s.count("home"), 5)),
    Trophy("smart_living", "Smart Living", "Control your smart home 25 times.", "silver", "home",
           lambda s: (s.count("home"), 25)),
    Trophy("oracle", "Oracle Seeker", "Ask the assistant for advice.", "bronze", "sparkles",
           lambda s: (s.count("ai"), 1)),
    Trophy("sharing_caring", "Sharing is Caring", "Share 3 things with a friend.", "silver", "share",
           lambda s: (s.count("share"), 3)),
    Trophy("on_fire", "On Fire", "Keep a 3-day streak.", "silver", "flame",
           lambda s: (s.streak, 3)),
    Trophy("unstoppable", "Unstoppable", "Keep a 7-day streak.", "gold", "flame",
           lambda s: (s.streak, 7)),
    Trophy("critic", "Film Critic", "Rate 10 movies you have watched.", "silver", "star",
           lambda s: (s.count("rate"), 10)),
    Trophy("collector", "Game Collector", "Download 5 games from the Store.", "bronze", "download",
           lambda s: (s.count("install"), 5)),
    Trophy("cloud_keeper", "Cloud Keeper", "Upload 10 files to your Cloud Drive.", "bronze", "cloud",
           lambda s: (s.count("upload"), 10)),
    Trophy("questmaster", "Questmaster", "Complete 10 daily quests.", "gold", "target",
           lambda s: (s.quests_done, 10)),
    Trophy("high_five", "High Five", "Reach level 5.", "silver", "star",
           lambda s: (s.level, 5)),
    Trophy("renaissance", "Renaissance Pi", "Watch, listen, play, control the house and ask Claude in one day.",
           "gold", "crown", lambda s: (len(s.kinds_today & CATEGORY_KINDS), 5)),
]
TROPHIES.append(Trophy(
    "platinum", "aPiStation Platinum", "Unlock every other trophy.", "platinum", "trophy",
    lambda s: (len(s.unlocked & {t.id for t in TROPHIES}), len(TROPHIES)),
))
TROPHY_BY_ID = {t.id: t for t in TROPHIES}

QUEST_POOL = [
    {"id": "q_watch", "title": "Movie Break", "description": "Watch a movie", "kind": "watch", "target": 1, "xp": 50, "icon": "film"},
    {"id": "q_listen", "title": "Daily Soundtrack", "description": "Play music twice", "kind": "listen", "target": 2, "xp": 40, "icon": "music"},
    {"id": "q_play", "title": "Player One", "description": "Launch a game", "kind": "play", "target": 1, "xp": 40, "icon": "gamepad"},
    {"id": "q_home", "title": "House Keeper", "description": "Use 3 smart home controls", "kind": "home", "target": 3, "xp": 30, "icon": "home"},
    {"id": "q_ai", "title": "Ask the Oracle", "description": "Ask the assistant something", "kind": "ai", "target": 1, "xp": 30, "icon": "sparkles"},
    {"id": "q_share", "title": "Good Vibes Only", "description": "Share something with a friend", "kind": "share", "target": 1, "xp": 40, "icon": "share"},
    {"id": "q_install", "title": "New Arrival", "description": "Download a game from the Store", "kind": "install", "target": 1, "xp": 30, "icon": "download"},
    {"id": "q_score", "title": "Snake Charmer", "description": "Score 10+ in π Snake", "kind": "score", "target": 1, "xp": 50, "icon": "zap", "min_score": 10},
]
QUEST_BY_ID = {q["id"]: q for q in QUEST_POOL}


def _today() -> str:
    return date.today().isoformat()


def _met(trophy: Trophy, stats: Stats) -> bool:
    current, target = trophy.progress(stats)
    return current >= target


class Gamification:
    def __init__(self, db: Database):
        self.db = db

    # ---------- quests ----------
    def daily_quests(self, pid: str, day: str | None = None) -> list[dict]:
        day = day or _today()
        rows = self.db.all("SELECT * FROM quests WHERE profile_id=? AND day=?", (pid, day))
        if not rows:
            picks = random.Random(f"{pid}:{day}").sample(QUEST_POOL, 3)
            with self.db.write() as conn:
                conn.executemany(
                    "INSERT OR IGNORE INTO quests(profile_id, day, quest_id) VALUES (?,?,?)",
                    [(pid, day, q["id"]) for q in picks],
                )
            rows = self.db.all("SELECT * FROM quests WHERE profile_id=? AND day=?", (pid, day))
        out = []
        for row in rows:
            q = QUEST_BY_ID.get(row["quest_id"])
            if q:
                out.append({**q, "progress": row["progress"], "done": bool(row["done"])})
        return out

    def _advance_quests(self, pid: str, kind: str, meta: dict) -> list[dict]:
        completed = []
        for quest in self.daily_quests(pid):
            if quest["done"] or quest["kind"] != kind:
                continue
            if quest.get("min_score") and meta.get("score", 0) < quest["min_score"]:
                continue
            progress = quest["progress"] + 1
            done = progress >= quest["target"]
            with self.db.write() as conn:
                conn.execute(
                    "UPDATE quests SET progress=?, done=? WHERE profile_id=? AND day=? AND quest_id=?",
                    (progress, int(done), pid, _today(), quest["id"]),
                )
            if done:
                completed.append({"id": quest["id"], "title": quest["title"], "xp": quest["xp"], "icon": quest["icon"]})
        return completed

    # ---------- stats & trophies ----------
    def stats(self, pid: str) -> Stats:
        counts = {r["kind"]: r["n"] for r in self.db.all(
            "SELECT kind, COUNT(*) AS n FROM activity WHERE profile_id=? GROUP BY kind", (pid,))}
        platforms = self.db.scalar(
            "SELECT COUNT(DISTINCT json_extract(meta, '$.platform')) FROM activity "
            "WHERE profile_id=? AND kind='play'", (pid,)) or 0
        best = self.db.scalar(
            "SELECT MAX(CAST(json_extract(meta, '$.score') AS INTEGER)) FROM activity "
            "WHERE profile_id=? AND kind='score'", (pid,)) or 0
        today_kinds = {r["kind"] for r in self.db.all(
            "SELECT DISTINCT kind FROM activity WHERE profile_id=? AND date(ts)=?", (pid, _today()))}
        quests_done = self.db.scalar("SELECT COUNT(*) FROM quests WHERE profile_id=? AND done=1", (pid,)) or 0
        profile = self.db.one("SELECT xp, streak FROM profiles WHERE id=?", (pid,))
        unlocked = {r["trophy_id"] for r in self.db.all("SELECT trophy_id FROM trophies WHERE profile_id=?", (pid,))}
        return Stats(counts, platforms, best, profile["streak"], level_for(profile["xp"]),
                     quests_done, today_kinds, unlocked)

    def trophies(self, pid: str) -> list[dict]:
        stats = self.stats(pid)
        unlocked = {r["trophy_id"]: r["unlocked_at"] for r in self.db.all(
            "SELECT trophy_id, unlocked_at FROM trophies WHERE profile_id=?", (pid,))}
        out = []
        for t in TROPHIES:
            current, target = t.progress(stats)
            out.append({
                "id": t.id, "name": t.name, "description": t.description, "tier": t.tier, "icon": t.icon,
                "progress": min(current, target), "target": target,
                "unlocked": t.id in unlocked, "unlocked_at": unlocked.get(t.id),
            })
        return out

    def _evaluate_trophies(self, pid: str) -> list[dict]:
        """Unlock any trophies whose goal is met. Trophy XP can unlock more, so loop."""
        new = []
        for _ in range(4):
            stats = self.stats(pid)
            fresh = [t for t in TROPHIES if t.id not in stats.unlocked and _met(t, stats)]
            if not fresh:
                break
            with self.db.write() as conn:
                for t in fresh:
                    conn.execute("INSERT OR IGNORE INTO trophies(profile_id, trophy_id) VALUES (?,?)", (pid, t.id))
                    conn.execute("UPDATE profiles SET xp = xp + ? WHERE id=?", (TROPHY_XP[t.tier], pid))
            new += [{"id": t.id, "name": t.name, "description": t.description, "tier": t.tier,
                     "icon": t.icon, "xp": TROPHY_XP[t.tier]} for t in fresh]
        return new

    # ---------- actions ----------
    def _base_xp(self, pid: str, kind: str, item_id: str | None, meta: dict) -> tuple[int, str | None]:
        base, cap = XP_RULES.get(kind, (0, None))
        if kind == "score":
            base = min(10 + int(meta.get("score", 0)) * 2, 80)
        today = _today()
        if kind in ONCE_PER_ITEM and item_id:
            seen = self.db.scalar(
                "SELECT COUNT(*) FROM activity WHERE profile_id=? AND kind=? AND item_id=? AND date(ts)=? AND xp>0",
                (pid, kind, item_id, today))
            if seen:
                return 0, "Already rewarded today"
        if cap is not None:
            rewarded = self.db.scalar(
                "SELECT COUNT(*) FROM activity WHERE profile_id=? AND kind=? AND date(ts)=? AND xp>0",
                (pid, kind, today))
            if rewarded >= cap:
                return 0, "Daily XP limit reached"
        return base, None

    def record(self, pid: str, kind: str, item_id: str | None = None,
               title: str | None = None, meta: dict | None = None) -> dict:
        """Log an action and return everything the console needs to celebrate it."""
        meta = meta or {}
        level_before = level_for(self.db.scalar("SELECT xp FROM profiles WHERE id=?", (pid,)))
        xp, note = self._base_xp(pid, kind, item_id, meta)
        with self.db.write() as conn:
            conn.execute(
                "INSERT INTO activity(profile_id, kind, item_id, title, meta, xp) VALUES (?,?,?,?,?,?)",
                (pid, kind, item_id, title, dumps(meta), xp))
            conn.execute("UPDATE profiles SET xp = xp + ? WHERE id=?", (xp, pid))

        quests = self._advance_quests(pid, kind, meta)
        if quests:
            with self.db.write() as conn:
                conn.execute("UPDATE profiles SET xp = xp + ? WHERE id=?", (sum(q["xp"] for q in quests), pid))
        trophies = self._evaluate_trophies(pid)

        profile = self.summary(pid)
        return {
            "kind": kind,
            "xp": xp,
            "note": note,
            "total_xp_gained": xp + sum(q["xp"] for q in quests) + sum(t["xp"] for t in trophies),
            "quests_completed": quests,
            "trophies_unlocked": trophies,
            "level_before": level_before,
            "level_after": profile["level"],
            "leveled_up": profile["level"] > level_before,
            "profile": profile,
        }

    def login(self, pid: str) -> dict:
        today = date.today()
        row = self.db.one("SELECT streak, last_active FROM profiles WHERE id=?", (pid,))
        last = date.fromisoformat(row["last_active"]) if row["last_active"] else None
        if last == today:
            # Already signed in today: nothing to log or reward.
            profile = self.summary(pid)
            return {"kind": "login", "xp": 0, "note": None, "total_xp_gained": 0, "quests_completed": [],
                    "trophies_unlocked": [], "level_before": profile["level"], "level_after": profile["level"],
                    "leveled_up": False, "profile": profile}
        streak = row["streak"] + 1 if last == today - timedelta(days=1) else 1
        with self.db.write() as conn:
            conn.execute("UPDATE profiles SET streak=?, last_active=? WHERE id=?", (streak, today.isoformat(), pid))
        return self.record(pid, "login")

    # ---------- read models ----------
    def summary(self, pid: str) -> dict:
        p = self.db.one("SELECT * FROM profiles WHERE id=?", (pid,))
        level = level_for(p["xp"])
        floor, ceil = xp_threshold(level), xp_threshold(level + 1)
        tiers = {t: 0 for t in TROPHY_XP}
        for r in self.db.all("SELECT trophy_id FROM trophies WHERE profile_id=?", (pid,)):
            if r["trophy_id"] in TROPHY_BY_ID:
                tiers[TROPHY_BY_ID[r["trophy_id"]].tier] += 1
        last = self.db.one(
            "SELECT kind, title, ts FROM activity WHERE profile_id=? AND kind != 'login' ORDER BY id DESC LIMIT 1", (pid,))
        nxt = next_title(level)
        return {
            "id": p["id"], "name": p["name"], "hue": p["hue"],
            "xp": p["xp"], "level": level, "title": title_for(level),
            "next_title": {"level": nxt[0], "title": nxt[1]} if nxt else None,
            "level_floor": floor, "level_ceil": ceil,
            "progress": round((p["xp"] - floor) / max(ceil - floor, 1), 4),
            "streak": p["streak"], "last_active": p["last_active"],
            "trophies": {**tiers, "total": sum(tiers.values()), "possible": len(TROPHIES)},
            "unread": self.db.scalar("SELECT COUNT(*) FROM shares WHERE to_profile=? AND seen=0", (pid,)),
            "last_activity": last,
        }

    def activity(self, pid: str | None = None, limit: int = 30) -> list[dict]:
        where, params = ("WHERE a.profile_id=?", (pid,)) if pid else ("", ())
        rows = self.db.all(
            f"SELECT a.*, p.name AS profile_name, p.hue AS profile_hue FROM activity a "
            f"JOIN profiles p ON p.id = a.profile_id {where} ORDER BY a.id DESC LIMIT ?", params + (limit,))
        for r in rows:
            r["meta"] = json.loads(r["meta"])
        return rows
