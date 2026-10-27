"""Game Store: installs and removes catalog games in the background, one job at a time.

ROM games are downloaded into the ROM folder; PC games are installed with apt. Only games listed
in store_catalog can be touched, so the API can never install or remove arbitrary packages.
"""

import logging
import os
import queue
import shutil
import subprocess
import threading
import time
import urllib.request
from typing import Callable

from ..config import Settings
from ..store_catalog import STORE, STORE_BY_ID

log = logging.getLogger("apistation.store")

ACTIVE = ("queued", "running")
# Root helper installed by kiosk/setup-store.sh; it only accepts the catalog's game packages.
HELPER = "/usr/local/sbin/apistation-pkg"
SETUP_HINT = "PC games need a one-time setup: run  sudo ~/aPiConsole/kiosk/setup-store.sh  in a terminal"


class Store:
    def __init__(self, settings: Settings, on_finished: Callable[[dict], None]):
        self.s = settings
        self.on_finished = on_finished
        self.jobs: dict[str, dict] = {}
        self._queue: queue.Queue = queue.Queue()
        self._lock = threading.Lock()
        self._pc_checked = (0.0, False)
        threading.Thread(target=self._worker, daemon=True, name="store-worker").start()

    # ---------- state ----------
    def installed(self, entry: dict) -> bool:
        inst = entry["install"]
        if inst["type"] == "rom":
            return (self.s.roms_dir / inst["rom"]).is_file()
        return shutil.which(inst["exec"]) is not None

    def catalog(self) -> list[dict]:
        out = []
        for entry in STORE:
            item = {k: v for k, v in entry.items() if k != "install"}
            item.update({
                "install_type": entry["install"]["type"],
                "installed": self.installed(entry),
                "poster": f"/assets/covers/{entry['id']}.jpg",
                "job": self.jobs.get(entry["id"]),
            })
            out.append(item)
        return out

    def pc_enabled(self) -> bool:
        """True when the hub may run the package helper without a password."""
        now = time.time()
        if now - self._pc_checked[0] > 30:
            ok = os.path.exists(HELPER) and subprocess.run(
                ["sudo", "-n", "-l", HELPER], capture_output=True).returncode == 0
            self._pc_checked = (now, ok)
        return self._pc_checked[1]

    def active_jobs(self) -> list[dict]:
        return [j for j in self.jobs.values() if j["state"] in ACTIVE or time.time() - j.get("finished", 0) < 30]

    # ---------- jobs ----------
    def enqueue(self, game_id: str, action: str, profile_id: str | None) -> dict:
        entry = STORE_BY_ID[game_id]
        with self._lock:
            current = self.jobs.get(game_id)
            if current and current["state"] in ACTIVE:
                return current
            job = {"id": game_id, "title": entry["title"], "action": action, "state": "queued", "progress": 0.0,
                   "message": "Waiting in line…", "profile_id": profile_id, "event": None, "started": time.time()}
            self.jobs[game_id] = job
        self._queue.put(job)
        return job

    def _worker(self) -> None:
        while True:
            job = self._queue.get()
            entry = STORE_BY_ID[job["id"]]
            job["state"] = "running"
            try:
                if job["action"] == "install":
                    self._install(entry, job)
                    job.update(message="Installed", progress=1.0)
                else:
                    self._uninstall(entry, job)
                    job.update(message="Removed", progress=1.0)
                job["state"] = "done"
            except Exception as exc:  # report to the console instead of dying
                log.warning("Store job %s %s failed: %s", job["action"], job["id"], exc)
                job.update(state="error", message=str(exc)[:240])
            finally:
                job["finished"] = time.time()
                try:
                    self.on_finished(job)
                except Exception:
                    log.exception("Store callback failed")

    def _install(self, entry: dict, job: dict) -> None:
        inst = entry["install"]
        if inst["type"] == "rom":
            self._download(inst["url"], self.s.roms_dir / inst["rom"], job)
        else:
            self._apt("install", inst["packages"], job)

    def _uninstall(self, entry: dict, job: dict) -> None:
        inst = entry["install"]
        if inst["type"] == "rom":
            (self.s.roms_dir / inst["rom"]).unlink(missing_ok=True)  # saves and save states are kept
        else:
            self._apt("remove", inst["packages"], job)

    def _download(self, url: str, dest, job: dict) -> None:
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_suffix(dest.suffix + ".part")
        req = urllib.request.Request(url, headers={"User-Agent": "aPiStation"})
        with urllib.request.urlopen(req, timeout=60) as resp, open(tmp, "wb") as out:
            total = int(resp.headers.get("Content-Length") or 0)
            done = 0
            while chunk := resp.read(64 * 1024):
                out.write(chunk)
                done += len(chunk)
                job["progress"] = done / total if total else min(0.9, done / 4_000_000)
                job["message"] = f"Downloading… {done // 1024} KB"
        tmp.replace(dest)

    def _apt(self, action: str, packages: list[str], job: dict) -> None:
        if not self.pc_enabled():
            raise RuntimeError(SETUP_HINT)
        proc = subprocess.Popen(["sudo", "-n", HELPER, action, *packages],
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        tail: list[str] = []
        downloading = action == "install"
        for line in proc.stdout:
            line = line.strip()
            if line.startswith("dlstatus:"):
                pct = float(line.split(":")[2])
                job["progress"] = pct / 100 * 0.75
                job["message"] = f"Downloading… {pct:.0f}%"
            elif line.startswith("pmstatus:"):
                _, pkg, pct, *_rest = line.split(":")
                base = 0.75 if downloading else 0.0
                job["progress"] = base + float(pct) / 100 * (1 - base)
                job["message"] = f"{'Installing' if downloading else 'Removing'} {pkg}…"
            elif line:
                tail = (tail + [line])[-4:]
        if proc.wait() != 0:
            raise RuntimeError(" ".join(tail) or f"apt-get exited with {proc.returncode}")
