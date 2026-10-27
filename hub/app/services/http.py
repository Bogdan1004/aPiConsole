"""Tiny JSON-over-HTTP helper for the service adapters (stdlib only)."""

import json
import urllib.parse
import urllib.request

# Some public APIs reject Python's default user agent.
USER_AGENT = "aPiStation/0.1 (Raspberry Pi home console)"


def get_json(url: str, params: dict | None = None, headers: dict | None = None, timeout: float = 4.0):
    if params:
        url = f"{url}{'&' if '?' in url else '?'}{urllib.parse.urlencode(params, doseq=True)}"
    req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": USER_AGENT, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def post_json(url: str, body: dict, headers: dict | None = None, timeout: float = 4.0):
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(), method="POST",
        headers={"Content-Type": "application/json", "Accept": "application/json", **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode()
        return json.loads(raw) if raw else None
