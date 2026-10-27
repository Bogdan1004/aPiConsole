"""Cloud Drive: the NAS side of aPiStation.

Everything lives in one folder (APISTATION_STORAGE, default ~/aPiCloud), never the whole home folder, so the hub's
own files (keys in hub/.env, the database) can't be reached through it. Inside: "Shared" for everyone and one private
folder per profile. Files can be uploaded from any browser, previewed, downloaded, renamed, moved, deleted (to a
trash kept 30 days) and shared through links that expire. Remote access is meant to go through Tailscale (private
network between your own devices), which the hub only detects.
"""

import json
import logging
import secrets
import shutil
import subprocess
import time
from datetime import datetime
from pathlib import Path

from ..auth import GUEST
from ..db import Database

log = logging.getLogger("apistation.drive")

SHARED = "Shared"
GUEST_FOLDER = "Guest"
TRASH = ".trash"
TRASH_DAYS = 30
RESERVE = 1 << 30  # always leave 1 GB free on the disk
KINDS = {
    "image": {"jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "avif"},
    "video": {"mp4", "webm", "mkv", "mov", "m4v", "ogv"},
    "audio": {"mp3", "flac", "ogg", "wav", "m4a", "opus", "aac"},
    "text": {"txt", "md", "json", "csv", "log", "py", "js", "html", "css", "xml", "yaml", "yml", "ini", "sh"},
    "pdf": {"pdf"},
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS drive_links (
    token TEXT PRIMARY KEY, path TEXT NOT NULL, profile_id TEXT NOT NULL, expires_at REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')));
"""


class DriveError(Exception):
    """A request the drive refuses (bad name, no access, no space…); the message is shown to the person."""


def kind_of(path: Path) -> str:
    ext = path.suffix.lower().lstrip(".")
    return next((k for k, exts in KINDS.items() if ext in exts), "other")


def _clean_name(name: str) -> str:
    name = (name or "").strip().replace("/", "_").replace("\\", "_").replace("\0", "")
    if not name or name in (".", "..") or name.startswith("."):
        raise DriveError("That name isn't allowed")
    return name[:200]


class Drive:
    def __init__(self, root: Path, db: Database, profiles: list[dict]):
        self.root = root.expanduser()
        self.db = db
        self.profiles = profiles
        first_run = not self.root.exists()
        for folder in [SHARED, TRASH, *(p["name"] for p in profiles if p["id"] != GUEST)]:
            (self.root / folder).mkdir(parents=True, exist_ok=True)
        if first_run:
            self._welcome(self.root / SHARED)
        if not (self.root / GUEST_FOLDER).exists():
            (self.root / GUEST_FOLDER).mkdir()
            self._welcome(self.root / GUEST_FOLDER)
        with db.write() as conn:
            conn.executescript(SCHEMA)
            conn.execute("DELETE FROM drive_links WHERE expires_at < ?", (time.time(),))
        self._empty_old_trash()

    def _welcome(self, folder: Path) -> None:
        (folder / "Welcome to aPiCloud.txt").write_text(
            "This is your aPiStation cloud.\n\n"
            "Shared: everyone on the console sees these files.\n"
            "Your own folder: only you see it in the console.\n\n"
            "Upload from a laptop or phone at http://apiconsole.local:8420 (Cloud Drive > Upload),\n"
            "or drag files onto the page. Share any file with a link that expires.\n")
        shots = Path(__file__).resolve().parents[3] / "docs" / "screenshots"
        if shots.is_dir():
            dest = folder / "aPiStation screenshots"
            dest.mkdir(exist_ok=True)
            for shot in sorted(shots.glob("*.jpg"))[:6]:
                shutil.copy2(shot, dest / shot.name)

    def _empty_old_trash(self) -> None:
        limit = time.time() - TRASH_DAYS * 86400
        for item in (self.root / TRASH).glob("*/*"):
            try:
                if item.stat().st_mtime < limit:
                    shutil.rmtree(item) if item.is_dir() else item.unlink()
            except OSError:
                pass

    # ---------- access ----------
    def areas(self, profile: dict) -> list[str]:
        # The Guest profile only sees its own demo folder (read-only, enforced by auth), never your files.
        if profile["id"] == GUEST:
            return [GUEST_FOLDER]
        return [SHARED, profile["name"]]

    def resolve(self, profile: dict, rel: str) -> Path:
        """The real path for `rel`, only inside Shared or the profile's own folder."""
        parts = [p for p in (rel or "").replace("\\", "/").split("/") if p]
        if any(p in (".", "..") or p.startswith(".") for p in parts):
            raise DriveError("That path isn't allowed")
        if parts and parts[0] not in self.areas(profile):
            raise DriveError("That folder belongs to someone else")
        root = self.root.resolve()
        target = (root.joinpath(*parts)).resolve()
        if not target.is_relative_to(root):
            raise DriveError("That path isn't allowed")
        return target

    def rel(self, path: Path) -> str:
        return str(path.resolve().relative_to(self.root.resolve()))

    def _entry(self, path: Path) -> dict:
        st = path.stat()
        is_dir = path.is_dir()
        return {
            "name": path.name, "path": self.rel(path), "dir": is_dir,
            "size": None if is_dir else st.st_size,
            "items": sum(1 for c in path.iterdir() if not c.name.startswith(".")) if is_dir else None,
            "modified": datetime.fromtimestamp(st.st_mtime).isoformat(timespec="minutes"),
            "kind": "folder" if is_dir else kind_of(path), "ext": path.suffix.lower().lstrip("."),
        }

    # ---------- browsing ----------
    def listing(self, profile: dict, rel: str = "") -> dict:
        target = self.resolve(profile, rel)
        if not target.is_dir():
            raise DriveError("Folder not found")
        if target == self.root.resolve():
            children = [self.root / a for a in self.areas(profile)]
        else:
            children = sorted((c for c in target.iterdir() if not c.name.startswith(".")),
                              key=lambda p: (not p.is_dir(), p.name.lower()))
        entries = []
        for child in children[:500]:
            try:
                entries.append(self._entry(child))
            except OSError:
                continue
        path = "" if target == self.root.resolve() else self.rel(target)
        return {"path": path, "entries": entries, "areas": self.areas(profile)}

    def recent(self, profile: dict, limit: int = 12) -> list[dict]:
        """Newest files across Shared and the profile's folder."""
        found = []
        for area in self.areas(profile):
            for f in (self.root / area).rglob("*"):
                if f.is_file() and not any(p.startswith(".") for p in f.relative_to(self.root).parts):
                    found.append((f.stat().st_mtime, f))
        found.sort(reverse=True)
        out = []
        for _, f in found[:limit]:
            e = self._entry(f)
            e["owner"] = f.relative_to(self.root).parts[0]
            out.append(e)
        return out

    # ---------- changes ----------
    def _unique(self, folder: Path, name: str) -> Path:
        dest = folder / name
        stem, suffix, n = dest.stem, dest.suffix, 1
        while dest.exists():
            dest = folder / f"{stem} ({n}){suffix}"
            n += 1
        return dest

    def upload_target(self, profile: dict, rel_folder: str, name: str, size: int) -> Path:
        folder = self.resolve(profile, rel_folder)
        if folder == self.root.resolve() or not folder.is_dir():
            raise DriveError("Open Shared or your own folder first")
        if size and shutil.disk_usage(self.root).free - size < RESERVE:
            raise DriveError("Not enough free space on the Pi")
        return self._unique(folder, _clean_name(name))

    def mkdir(self, profile: dict, rel_folder: str, name: str) -> dict:
        folder = self.resolve(profile, rel_folder)
        if folder == self.root.resolve():
            raise DriveError("Open Shared or your own folder first")
        dest = self._unique(folder, _clean_name(name))
        dest.mkdir()
        return self._entry(dest)

    def _movable(self, profile: dict, rel: str) -> Path:
        path = self.resolve(profile, rel)
        if path.parent == self.root.resolve() or path == self.root.resolve():
            raise DriveError("Shared and personal folders can't be changed")
        if not path.exists():
            raise DriveError("File not found")
        return path

    def rename(self, profile: dict, rel: str, name: str) -> dict:
        path = self._movable(profile, rel)
        dest = path.with_name(_clean_name(name))
        if dest.exists():
            raise DriveError("Something with that name is already there")
        path.rename(dest)
        return self._entry(dest)

    def move(self, profile: dict, rel: str, to_folder: str) -> dict:
        path = self._movable(profile, rel)
        folder = self.resolve(profile, to_folder)
        if folder == self.root.resolve() or not folder.is_dir() or folder.is_relative_to(path):
            raise DriveError("Can't move it there")
        dest = self._unique(folder, path.name)
        shutil.move(str(path), dest)
        return self._entry(dest)

    def delete(self, profile: dict, rel: str) -> None:
        """Moves to the trash (kept 30 days), never deletes outright."""
        path = self._movable(profile, rel)
        bin_dir = self.root / TRASH / profile["id"]
        bin_dir.mkdir(parents=True, exist_ok=True)
        shutil.move(str(path), bin_dir / f"{datetime.now():%Y%m%d-%H%M%S} {path.name}")

    # ---------- share links ----------
    def link(self, profile: dict, rel: str, days: int = 7) -> dict:
        path = self.resolve(profile, rel)
        if not path.is_file():
            raise DriveError("Only files can be shared with a link")
        token = secrets.token_urlsafe(12)
        expires = time.time() + days * 86400
        with self.db.write() as conn:
            conn.execute("INSERT INTO drive_links(token, path, profile_id, expires_at) VALUES (?,?,?,?)",
                         (token, self.rel(path), profile["id"], expires))
        return {"token": token, "url": f"/s/{token}", "expires": datetime.fromtimestamp(expires).isoformat(timespec="minutes")}

    def shared_file(self, token: str) -> Path | None:
        row = self.db.one("SELECT path, expires_at FROM drive_links WHERE token=?", (token,))
        if not row or row["expires_at"] < time.time():
            return None
        path = (self.root / row["path"]).resolve()
        return path if path.is_file() and path.is_relative_to(self.root.resolve()) else None

    # ---------- remote access ----------
    @staticmethod
    def remote() -> dict:
        """Tailscale status, if it is installed (it gives the drive a private address reachable from anywhere)."""
        if not shutil.which("tailscale"):
            return {"tailscale": False}
        try:
            out = subprocess.run(["tailscale", "status", "--json"], capture_output=True, text=True, timeout=3)
            data = json.loads(out.stdout or "{}")
        except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
            return {"tailscale": True, "connected": False}
        me = data.get("Self") or {}
        return {"tailscale": True, "connected": data.get("BackendState") == "Running",
                "name": (me.get("DNSName") or "").rstrip("."), "ips": me.get("TailscaleIPs") or []}
