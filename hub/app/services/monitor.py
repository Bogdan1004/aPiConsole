"""Monitoring: the Pi's health over time, request counts, a security log and alerts.

A background thread samples every 15 seconds (CPU, temperature, memory, disk, network traffic, requests and
errors, devices online) and keeps 7 days in SQLite; charts ask for a range and get it averaged into at most ~120
points. The security log records sign-ins, wrong PINs, lockouts, blocked guest actions, rate limits, paired phones
and file changes (30 days). When the Pi runs hot or out of space, an alert is logged and pushed to the players'
screens, at most once per half hour per kind.
"""

import logging
import shutil
import threading
import time
from pathlib import Path
from typing import Callable

from ..db import Database

log = logging.getLogger("apistation.monitor")

INTERVAL = 15
KEEP_METRICS_DAYS = 7
KEEP_AUDIT_DAYS = 30
RANGES = {"1h": 3600, "24h": 86400, "7d": 7 * 86400}
ALERTS = {  # kind: (test, message)
    "temp": (lambda s: (s["temp"] or 0) >= 75, "The Pi is running hot ({temp:.0f}°C). Give it some air or a fan."),
    "disk": (lambda s: s["disk_free"] < 2 * 1024**3, "Less than 2 GB free on the Pi ({disk_gb:.1f} GB left)."),
    "memory": (lambda s: s["mem"] >= 92, "Memory is almost full ({mem:.0f}%)."),
}
ALERT_COOLDOWN = 1800

SCHEMA = """
CREATE TABLE IF NOT EXISTS metrics (
    ts REAL NOT NULL, cpu REAL, temp REAL, mem REAL, disk_free REAL, rx REAL, tx REAL,
    req INTEGER, err INTEGER, online INTEGER);
CREATE INDEX IF NOT EXISTS metrics_ts ON metrics(ts);
CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    kind TEXT NOT NULL, profile_id TEXT, address TEXT, detail TEXT);
"""


def _read(path: str) -> str:
    try:
        return Path(path).read_text()
    except OSError:
        return ""


def _net_bytes() -> tuple[int, int]:
    """Bytes received and sent on the real network interfaces (not loopback or Tailscale)."""
    rx = tx = 0
    for line in _read("/proc/net/dev").splitlines()[2:]:
        name, _, rest = line.partition(":")
        name = name.strip()
        if name == "lo" or name.startswith(("tailscale", "docker", "veth")):
            continue
        fields = rest.split()
        rx += int(fields[0])
        tx += int(fields[8])
    return rx, tx


def _cpu_times() -> tuple[int, int]:
    values = list(map(int, (_read("/proc/stat").splitlines() or ["cpu 0"])[0].split()[1:]))
    return (values[3] + values[4], sum(values)) if values else (0, 0)


class Monitor:
    def __init__(self, db: Database, storage_root: Path, online: Callable[[], int], alert: Callable[[dict], None]):
        self.db = db
        self.storage_root = storage_root
        self.online = online
        self.alert = alert
        self.requests = 0
        self.errors = 0
        self._lock = threading.Lock()
        self._last_alert: dict[str, float] = {}
        with db.write() as conn:
            conn.executescript(SCHEMA)
        threading.Thread(target=self._run, daemon=True, name="monitor").start()

    # ---------- counters (called for every request) ----------
    def count(self, status: int) -> None:
        with self._lock:
            self.requests += 1
            if status >= 500:
                self.errors += 1

    # ---------- security log ----------
    def audit(self, kind: str, profile_id: str | None = None, address: str | None = None, detail: str = "") -> None:
        with self.db.write() as conn:
            conn.execute("INSERT INTO audit(kind, profile_id, address, detail) VALUES (?,?,?,?)",
                         (kind, profile_id, address, detail[:200]))

    # ---------- sampling ----------
    def _run(self) -> None:
        cpu_prev, net_prev, t_prev = _cpu_times(), _net_bytes(), time.time()
        last_cleanup = 0.0
        while True:
            time.sleep(INTERVAL)
            try:
                now = time.time()
                cpu_now, net_now = _cpu_times(), _net_bytes()
                busy = (cpu_now[1] - cpu_prev[1]) or 1
                cpu = round(100 * (1 - (cpu_now[0] - cpu_prev[0]) / busy), 1)
                span = max(now - t_prev, 1)
                rx, tx = (net_now[0] - net_prev[0]) / span, (net_now[1] - net_prev[1]) / span
                cpu_prev, net_prev, t_prev = cpu_now, net_now, now
                temp_raw = _read("/sys/class/thermal/thermal_zone0/temp").strip()
                mem = {k: int(v.split()[0]) for k, _, v in (l.partition(":") for l in _read("/proc/meminfo").splitlines()) if v.split()}
                sample = {
                    "ts": now, "cpu": cpu, "temp": round(int(temp_raw) / 1000, 1) if temp_raw else None,
                    "mem": round(100 * (1 - mem.get("MemAvailable", 0) / max(mem.get("MemTotal", 1), 1)), 1),
                    "disk_free": shutil.disk_usage(self.storage_root if self.storage_root.exists() else "/").free,
                    "rx": max(rx, 0), "tx": max(tx, 0), "online": self.online(),
                }
                with self._lock:
                    sample["req"], sample["err"] = self.requests, self.errors
                    self.requests = self.errors = 0
                with self.db.write() as conn:
                    conn.execute("INSERT INTO metrics(ts, cpu, temp, mem, disk_free, rx, tx, req, err, online) "
                                 "VALUES (:ts,:cpu,:temp,:mem,:disk_free,:rx,:tx,:req,:err,:online)", sample)
                    if now - last_cleanup > 3600:
                        conn.execute("DELETE FROM metrics WHERE ts < ?", (now - KEEP_METRICS_DAYS * 86400,))
                        conn.execute("DELETE FROM audit WHERE ts < datetime('now', 'localtime', ?)", (f"-{KEEP_AUDIT_DAYS} days",))
                        last_cleanup = now
                self._check_alerts(sample)
            except Exception:  # never let monitoring take the hub down
                log.exception("Monitoring sample failed")

    def _check_alerts(self, s: dict) -> None:
        for kind, (test, message) in ALERTS.items():
            if not test(s) or time.time() - self._last_alert.get(kind, 0) < ALERT_COOLDOWN:
                continue
            self._last_alert[kind] = time.time()
            text = message.format(temp=s["temp"] or 0, disk_gb=s["disk_free"] / 1024**3, mem=s["mem"])
            self.audit("alert", None, None, text)
            self.alert({"t": "alert", "kind": kind, "text": text})

    # ---------- reading ----------
    def series(self, rng: str) -> list[dict]:
        seconds = RANGES.get(rng, 3600)
        bucket = max(INTERVAL, seconds // 120)
        rows = self.db.all(
            "SELECT CAST(ts / ? AS INTEGER) * ? AS t, AVG(cpu) cpu, AVG(temp) temp, AVG(mem) mem, MIN(disk_free) disk_free, "
            "AVG(rx) rx, AVG(tx) tx, SUM(req) req, SUM(err) err, MAX(online) online FROM metrics WHERE ts >= ? "
            "GROUP BY t ORDER BY t", (bucket, bucket, time.time() - seconds))
        for r in rows:
            r["req_per_min"] = round(r.pop("req") * 60 / bucket, 1)
            r["err_per_min"] = round(r.pop("err") * 60 / bucket, 2)
        return rows

    def latest(self) -> dict | None:
        return self.db.one("SELECT * FROM metrics ORDER BY ts DESC LIMIT 1")

    def events(self, limit: int = 40) -> list[dict]:
        return self.db.all("SELECT ts, kind, profile_id, address, detail FROM audit ORDER BY id DESC LIMIT ?", (limit,))
