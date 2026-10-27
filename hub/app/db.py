"""SQLite storage. One connection per thread, writes serialized with a lock."""

import json
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS profiles (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    hue         INTEGER NOT NULL,
    xp          INTEGER NOT NULL DEFAULT 0,
    streak      INTEGER NOT NULL DEFAULT 0,
    last_active TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS activity (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id TEXT NOT NULL REFERENCES profiles(id),
    kind       TEXT NOT NULL,
    item_id    TEXT,
    title      TEXT,
    meta       TEXT NOT NULL DEFAULT '{}',
    xp         INTEGER NOT NULL DEFAULT 0,
    ts         TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS activity_profile_ts ON activity(profile_id, ts);
CREATE TABLE IF NOT EXISTS trophies (
    profile_id  TEXT NOT NULL REFERENCES profiles(id),
    trophy_id   TEXT NOT NULL,
    unlocked_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    PRIMARY KEY (profile_id, trophy_id)
);
CREATE TABLE IF NOT EXISTS quests (
    profile_id TEXT NOT NULL REFERENCES profiles(id),
    day        TEXT NOT NULL,
    quest_id   TEXT NOT NULL,
    progress   INTEGER NOT NULL DEFAULT 0,
    done       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (profile_id, day, quest_id)
);
CREATE TABLE IF NOT EXISTS shares (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    from_profile TEXT NOT NULL REFERENCES profiles(id),
    to_profile   TEXT NOT NULL REFERENCES profiles(id),
    kind         TEXT NOT NULL,
    item_id      TEXT NOT NULL,
    title        TEXT NOT NULL,
    message      TEXT NOT NULL DEFAULT '',
    seen         INTEGER NOT NULL DEFAULT 0,
    ts           TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE TABLE IF NOT EXISTS ai_cache (
    profile_id TEXT NOT NULL,
    day        TEXT NOT NULL,
    kind       TEXT NOT NULL,
    payload    TEXT NOT NULL,
    PRIMARY KEY (profile_id, day, kind)
);
"""


class Database:
    def __init__(self, path: Path):
        self.path = path
        self._local = threading.local()
        self._write_lock = threading.Lock()
        path.parent.mkdir(parents=True, exist_ok=True)
        with self.write() as conn:
            conn.executescript(SCHEMA)

    def _conn(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = sqlite3.connect(self.path, timeout=10)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA foreign_keys=ON")
            self._local.conn = conn
        return conn

    def all(self, sql: str, params: tuple = ()) -> list[dict]:
        return [dict(row) for row in self._conn().execute(sql, params)]

    def one(self, sql: str, params: tuple = ()) -> dict | None:
        row = self._conn().execute(sql, params).fetchone()
        return dict(row) if row else None

    def scalar(self, sql: str, params: tuple = ()):
        row = self._conn().execute(sql, params).fetchone()
        return row[0] if row else None

    @contextmanager
    def write(self):
        with self._write_lock:
            conn = self._conn()
            try:
                yield conn
                conn.commit()
            except Exception:
                conn.rollback()
                raise


def dumps(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)
