"""Pi health (the "computing" part of the cloud) and the Cloud Drive file browser."""

import os
import shutil
import socket
import time
from datetime import datetime
from pathlib import Path


def _read(path: str) -> str | None:
    try:
        return Path(path).read_text().strip()
    except OSError:
        return None


def _meminfo() -> dict:
    info = {}
    for line in (_read("/proc/meminfo") or "").splitlines():
        key, _, rest = line.partition(":")
        info[key] = int(rest.split()[0]) * 1024 if rest.split() else 0
    return info


_cpu_prev: tuple[int, int] | None = None


def _cpu_percent() -> float | None:
    """CPU usage since the previous call, from /proc/stat."""
    global _cpu_prev
    fields = (_read("/proc/stat") or "").splitlines()[0].split()[1:]
    if not fields:
        return None
    values = list(map(int, fields))
    idle, total = values[3] + values[4], sum(values)
    prev, _cpu_prev = _cpu_prev, (idle, total)
    if not prev or total == prev[1]:
        return None
    return round(100 * (1 - (idle - prev[0]) / (total - prev[1])), 1)


def _ip() -> str | None:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
    except OSError:
        return None


def stats(storage_root: Path) -> dict:
    temp = _read("/sys/class/thermal/thermal_zone0/temp")
    mem = _meminfo()
    uptime = float((_read("/proc/uptime") or "0").split()[0])
    root = shutil.disk_usage("/")
    storage = shutil.disk_usage(storage_root) if storage_root.exists() else root
    return {
        "hostname": socket.gethostname(),
        "ip": _ip(),
        "model": (_read("/proc/device-tree/model") or "Unknown").rstrip("\x00"),
        "cpu_temp": round(int(temp) / 1000, 1) if temp else None,
        "cpu_percent": _cpu_percent(),
        "cpu_count": os.cpu_count(),
        "load": os.getloadavg(),
        "mem_total": mem.get("MemTotal"),
        "mem_used": (mem.get("MemTotal", 0) - mem.get("MemAvailable", 0)) or None,
        "uptime": int(uptime),
        "disk": {"total": root.total, "used": root.used, "free": root.free},
        "storage": {"path": str(storage_root), "total": storage.total, "used": storage.used, "free": storage.free},
        "time": time.time(),
    }
