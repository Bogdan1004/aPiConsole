"""Sign-in, guest mode and limits, so the console can be shown online without risk.

- Real profiles are protected by a 4-6 digit PIN (scrypt-hashed). Signing in creates a session kept in an
  HttpOnly cookie, so images, videos and ROMs load with it too. "Remember this device" keeps it for 90 days
  (the TV asks once); otherwise it lasts 12 hours.
- The Guest profile has no PIN and is read-only: it can look around, play in the browser, chat with the local
  model and rate things for itself, but can't change the Pi, the house, the files or the other profiles, can't
  start things on the TV and never triggers paid Claude calls. Its Cloud Drive is a separate demo folder.
- Every acting profile_id must be the signed-in one (checked in main._profile); guests can't read others' data.
- Rate limits: wrong PINs, requests per session, chat messages and forced Claude refreshes.
"""

import contextvars
import hashlib
import hmac
import re
import secrets
import time
from collections import defaultdict, deque
from dataclasses import dataclass

from .db import Database

GUEST = "guest"
COOKIE = "apistation_session"
REMEMBER_DAYS = 90
SESSION_HOURS = 12
GUEST_HOURS = 3
PIN_RE = re.compile(r"^\d{4,6}$")

SCHEMA = """
CREATE TABLE IF NOT EXISTS profile_pins (
    profile_id TEXT PRIMARY KEY REFERENCES profiles(id), pin_hash TEXT NOT NULL, salt TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')));
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id), expires_at REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')));
"""

# No sign-in needed: the boot and profile screens, the static console, public share links.
PUBLIC = [
    ("GET", re.compile(r"^/api/health$")),
    ("GET", re.compile(r"^/api/profiles$")),
    ("GET", re.compile(r"^/api/session$")),
    ("POST", re.compile(r"^/api/profiles/[\w-]+/login$")),
    ("POST", re.compile(r"^/api/profiles/[\w-]+/pin$")),  # first PIN only; changing one needs a session
    ("POST", re.compile(r"^/api/session/logout$")),
]

# What a guest may change (only its own profile's data). Every other POST/PUT/DELETE is refused.
GUEST_WRITES = [
    ("POST", re.compile(r"^/api/play$")),  # browser only, checked in the route
    ("POST", re.compile(r"^/api/games/score$")),
    ("POST", re.compile(r"^/api/films/[\w-]+/(watched|list)$")),
    ("DELETE", re.compile(r"^/api/films/[\w-]+/watched$")),
    ("POST", re.compile(r"^/api/music/(start|played|rate)$")),
    ("POST", re.compile(r"^/api/ai/chat$")),
    ("POST", re.compile(r"^/api/profiles/guest/inbox/seen$")),
]

# (bucket, limit, seconds) per session; guests get the tighter ones.
LIMITS = {
    "requests": (900, 60),
    "chat": (12, 60),
    "claude": (8, 3600),
}
GUEST_LIMITS = {
    "requests": (400, 60),
    "chat": (4, 60),
    "chat_day": (40, 86400),
}
PIN_TRIES = (5, 600)  # wrong PINs per profile and address before a 10-minute lock
PIN_TRIES_ANYWHERE = (10, 3600)  # and per profile from anywhere (addresses can be faked behind a proxy)


@dataclass
class Session:
    profile_id: str
    expires_at: float
    key: str = ""  # per signed-in device: every visitor using Guest gets their own limits

    @property
    def guest(self) -> bool:
        return self.profile_id == GUEST


current: contextvars.ContextVar[Session | None] = contextvars.ContextVar("session", default=None)


def _hash_pin(pin: str, salt: str) -> str:
    return hashlib.scrypt(pin.encode(), salt=bytes.fromhex(salt), n=2**14, r=8, p=1, dklen=32).hex()


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class RateLimiter:
    def __init__(self):
        self._hits: dict[tuple, deque] = defaultdict(deque)

    def hit(self, key: tuple, limit: int, seconds: float) -> bool:
        """Counts one hit; False when the limit for the window is already reached."""
        now = time.time()
        q = self._hits[key]
        while q and q[0] <= now - seconds:
            q.popleft()
        if len(q) >= limit:
            return False
        q.append(now)
        return True

    def failures(self, key: tuple, seconds: float) -> int:
        now = time.time()
        q = self._hits[key]
        while q and q[0] <= now - seconds:
            q.popleft()
        return len(q)


class Auth:
    def __init__(self, db: Database):
        self.db = db
        self.limiter = RateLimiter()
        with db.write() as conn:
            conn.executescript(SCHEMA)
            conn.execute("INSERT OR IGNORE INTO profiles(id, name, hue) VALUES (?, 'Guest', 200)", (GUEST,))
            conn.execute("DELETE FROM sessions WHERE expires_at < ?", (time.time(),))

    # ---------- PINs ----------
    def has_pin(self, pid: str) -> bool:
        return bool(self.db.scalar("SELECT 1 FROM profile_pins WHERE profile_id=?", (pid,)))

    def check_pin(self, pid: str, pin: str) -> bool:
        row = self.db.one("SELECT pin_hash, salt FROM profile_pins WHERE profile_id=?", (pid,))
        return bool(row) and hmac.compare_digest(row["pin_hash"], _hash_pin(pin or "", row["salt"]))

    def set_pin(self, pid: str, pin: str) -> None:
        salt = secrets.token_hex(16)
        with self.db.write() as conn:
            conn.execute("INSERT OR REPLACE INTO profile_pins(profile_id, pin_hash, salt) VALUES (?,?,?)",
                         (pid, _hash_pin(pin, salt), salt))
            # A new PIN signs out every other device.
            conn.execute("DELETE FROM sessions WHERE profile_id=?", (pid,))

    def pin_locked(self, pid: str, address: str) -> bool:
        return (self.limiter.failures(("pin", pid, address), PIN_TRIES[1]) >= PIN_TRIES[0]
                or self.limiter.failures(("pin", pid), PIN_TRIES_ANYWHERE[1]) >= PIN_TRIES_ANYWHERE[0])

    def pin_failed(self, pid: str, address: str) -> None:
        self.limiter.hit(("pin", pid, address), 10**6, PIN_TRIES[1])
        self.limiter.hit(("pin", pid), 10**6, PIN_TRIES_ANYWHERE[1])

    # ---------- sessions ----------
    def start(self, pid: str, remember: bool) -> tuple[str, int]:
        """New session; returns the cookie token and its lifetime in seconds."""
        hours = GUEST_HOURS if pid == GUEST else REMEMBER_DAYS * 24 if remember else SESSION_HOURS
        token = secrets.token_urlsafe(32)
        with self.db.write() as conn:
            conn.execute("INSERT INTO sessions(token_hash, profile_id, expires_at) VALUES (?,?,?)",
                         (_token_hash(token), pid, time.time() + hours * 3600))
        return token, hours * 3600

    def lookup(self, token: str | None) -> Session | None:
        if not token:
            return None
        row = self.db.one("SELECT profile_id, expires_at FROM sessions WHERE token_hash=?", (_token_hash(token),))
        if not row or row["expires_at"] < time.time():
            return None
        return Session(row["profile_id"], row["expires_at"], _token_hash(token)[:16])

    def end(self, token: str | None) -> None:
        if token:
            with self.db.write() as conn:
                conn.execute("DELETE FROM sessions WHERE token_hash=?", (_token_hash(token),))

    # ---------- rules ----------
    @staticmethod
    def is_public(method: str, path: str) -> bool:
        if not path.startswith("/api/"):
            return True  # the console itself and /s/ share links
        return any(method == m and rx.match(path) for m, rx in PUBLIC)

    @staticmethod
    def guest_may(method: str, path: str) -> bool:
        if method in ("GET", "HEAD"):
            return True
        return any(method == m and rx.match(path) for m, rx in GUEST_WRITES)

    def allow(self, session: Session, bucket: str) -> bool:
        limits = GUEST_LIMITS if session.guest else LIMITS
        # All guests together get 40 chat messages a day, so visitors can't keep the Pi's CPU busy.
        if bucket == "chat" and session.guest and not self.limiter.hit(("chat_day", GUEST), *GUEST_LIMITS["chat_day"]):
            return False
        if bucket not in limits:
            return True
        who = session.key if session.guest else session.profile_id
        return self.limiter.hit((bucket, who), *limits[bucket])


def client_address(headers, client) -> str:
    """The visitor's address, also behind a tunnel such as Tailscale Funnel (which connects from localhost)."""
    for header in ("cf-connecting-ip", "x-forwarded-for"):
        if headers.get(header):
            return headers[header].split(",")[0].strip()
    return client.host if client else "unknown"
