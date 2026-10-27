"""First-run data: two profiles with a few days of history, so the demo feels lived in."""

from datetime import date, datetime, timedelta

from . import demo_data
from .db import Database, dumps
from .gamification import TROPHY_BY_ID, TROPHY_XP, XP_RULES

# (days ago, hour, kind, item_id, title, meta)
HISTORY = {
    "bogdan": [
        (4, 19, "login", None, None, {}),
        (4, 20, "watch", "big-buck-bunny", "Big Buck Bunny", {"genres": ["Animation", "Comedy"]}),
        (4, 22, "listen", "late-night-pi", "Late Night π", {"genre": "Lo-Fi"}),
        (3, 18, "login", None, None, {}),
        (3, 18, "play", "pi-snake", "π Snake", {"platform": "aPiStation"}),
        (3, 18, "score", "pi-snake", "π Snake", {"score": 14}),
        (3, 21, "ai", None, "Asked Claude for a movie", {}),
        (2, 17, "login", None, None, {}),
        (2, 20, "watch", "sintel", "Sintel", {"genres": ["Fantasy", "Adventure"]}),
        (2, 21, "listen", "grid-runner", "Grid Runner", {"genre": "Synthwave"}),
        (2, 21, "home", "movie_night", "Movie Night", {}),
        (2, 23, "home", "good_night", "Good Night", {}),
        (1, 18, "login", None, None, {}),
        (1, 18, "play", "thwaite", "Thwaite", {"platform": "NES"}),
        (1, 20, "watch", "tears-of-steel", "Tears of Steel", {"genres": ["Sci-Fi", "Action"]}),
        (1, 22, "listen", "pixel-hearts", "Pixel Hearts", {"genre": "Chiptune"}),
    ],
    "alex": [
        (2, 16, "login", None, None, {}),
        (2, 16, "listen", "stardust", "Stardust", {"genre": "Ambient"}),
        (2, 17, "play", "libbet", "Libbet and the Magic Floor", {"platform": "Game Boy"}),
        (2, 19, "listen", "nimbus", "Nimbus", {"genre": "Ambient"}),
    ],
}
TROPHIES = {
    "bogdan": [(4, "hello_world"), (4, "popcorn"), (4, "drop_the_beat"), (3, "insert_coin"), (3, "oracle"),
               (2, "on_fire")],
    "alex": [(2, "hello_world"), (2, "drop_the_beat"), (2, "insert_coin")],
}
STREAKS = {"bogdan": (4, 1), "alex": (1, 2)}  # (streak, last active days ago)


def _ts(days_ago: int, hour: int) -> str:
    return (datetime.now() - timedelta(days=days_ago)).replace(hour=hour, minute=12, second=0).strftime("%Y-%m-%d %H:%M:%S")


def seed(db: Database) -> None:
    if db.scalar("SELECT COUNT(*) FROM profiles"):
        return
    with db.write() as conn:
        for p in demo_data.PROFILES:
            pid = p["id"]
            streak, last_days = STREAKS[pid]
            last_active = (date.today() - timedelta(days=last_days)).isoformat()
            conn.execute("INSERT INTO profiles(id, name, hue, streak, last_active) VALUES (?,?,?,?,?)",
                         (pid, p["name"], p["hue"], streak, last_active))
            xp = 0
            for days, hour, kind, item_id, title, meta in HISTORY.get(pid, []):
                gained = min(10 + meta["score"] * 2, 80) if kind == "score" else XP_RULES[kind][0]
                xp += gained
                conn.execute(
                    "INSERT INTO activity(profile_id, kind, item_id, title, meta, xp, ts) VALUES (?,?,?,?,?,?,?)",
                    (pid, kind, item_id, title, dumps(meta), gained, _ts(days, hour)))
            for days, trophy_id in TROPHIES.get(pid, []):
                xp += TROPHY_XP[TROPHY_BY_ID[trophy_id].tier]
            conn.execute("UPDATE profiles SET xp=? WHERE id=?", (xp, pid))
            conn.executemany(
                "INSERT INTO trophies(profile_id, trophy_id, unlocked_at) VALUES (?,?,?)",
                [(pid, trophy_id, _ts(days, 21)) for days, trophy_id in TROPHIES.get(pid, [])])
        conn.execute(
            "INSERT INTO shares(from_profile, to_profile, kind, item_id, title, message, ts) VALUES (?,?,?,?,?,?,?)",
            ("alex", "bogdan", "album", "stardust", "Stardust", "Perfect for late-night coding!", _ts(2, 19)))
