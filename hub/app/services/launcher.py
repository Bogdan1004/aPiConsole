"""Starts native players and emulators on the TV. Only catalog items, never arbitrary commands."""

import logging
import os
import shutil
import subprocess
import threading
from pathlib import Path

from ..config import REPO_DIR, Settings
from .library import find_core

# Kiosk-friendly RetroArch overrides (fullscreen, Start+Select quits back to the console).
RETROARCH_CFG = REPO_DIR / "kiosk" / "retroarch.cfg"

log = logging.getLogger("apistation.launcher")
NETPLAY_PORT = 55435  # RetroArch's default netplay port


def _session_env() -> dict:
    """The hub may start before the desktop session; point players at the TV's Wayland display."""
    env = dict(os.environ)
    env.setdefault("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")
    env.setdefault("WAYLAND_DISPLAY", "wayland-0")
    return env


class Launcher:
    def __init__(self, settings: Settings):
        self.s = settings
        self._proc: subprocess.Popen | None = None
        self._current: dict | None = None
        self._lock = threading.Lock()

    def _command(self, item: dict) -> list[str] | None:
        if not self.s.launch_native:
            return None
        if item["kind"] == "movie":
            source = item.get("stream") or item.get("path")
            player = shutil.which("vlc") or shutil.which("mpv")
            if not (source and player):
                return None
            if player.endswith("vlc"):
                return [player, "--fullscreen", "--play-and-exit", "--no-video-title-show", source]
            return [player, "--fs", source]
        if item["kind"] == "game":
            launch = item["launch"]
            if launch["type"] == "native" and shutil.which(launch["exec"]):
                return [shutil.which(launch["exec"]), *launch.get("args", [])]
            if launch["type"] == "retroarch":
                retroarch, core = shutil.which("retroarch"), find_core(launch["rom"].split("/", 1)[0])
                rom = self.s.roms_dir / launch["rom"]
                if retroarch and core and rom.is_file():
                    extra = ["--appendconfig", str(RETROARCH_CFG)] if RETROARCH_CFG.is_file() else []
                    return [retroarch, "-f", *extra, "-L", str(core), str(rom)]
        return None

    def launch(self, item: dict, netplay_nick: str | None = None) -> dict:
        """Returns how the console should present the item: native, builtin or simulated.
        `netplay_nick`: start a RetroArch game as an online host that a friend's RetroArch can join."""
        if item["kind"] == "game" and item["launch"]["type"] == "builtin":
            return {"mode": "builtin", "game": item["launch"]["game"]}
        if item["kind"] == "album":
            return {"mode": "browser"}
        cmd = self._command(item)
        if not cmd:
            return {"mode": "simulated"}
        netplay = bool(netplay_nick) and item["kind"] == "game" and item["launch"]["type"] == "retroarch"
        if netplay:
            cmd = [*cmd, "--host", "--nick", netplay_nick]
        with self._lock:
            self.stop()
            log.info("Launching %s", cmd)
            self._proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                          start_new_session=True, env=_session_env())
            self._current = {"id": item["id"], "kind": item["kind"], "title": item["title"]}
        return {"mode": "native", **({"netplay": {"port": NETPLAY_PORT, "core": Path(cmd[cmd.index("-L") + 1]).name,
                                                   "rom": Path(cmd[cmd.index("-L") + 2]).name}} if netplay else {})}

    def status(self) -> dict:
        running = self._proc is not None and self._proc.poll() is None
        return {"running": running, "item": self._current if running else None}

    def stop(self) -> None:
        if self._proc and self._proc.poll() is None:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self._proc.kill()
        self._proc, self._current = None, None
