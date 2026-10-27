"""Smart home: Home Assistant when configured, an in-memory demo house otherwise."""

import copy
import logging
import threading

from .. import demo_data
from ..config import Settings
from .http import get_json, post_json

log = logging.getLogger("apistation.home")

HA_DOMAINS = {"light": "light", "switch": "switch", "fan": "fan", "climate": "climate",
              "lock": "lock", "media_player": "media"}


def _hex_to_rgb(color: str) -> list[int]:
    color = color.lstrip("#")
    return [int(color[i:i + 2], 16) for i in (0, 2, 4)]


def _rgb_to_hex(rgb) -> str:
    return "#" + "".join(f"{int(c):02x}" for c in rgb[:3])


class SmartHome:
    def __init__(self, settings: Settings):
        self.s = settings
        self.mode = "homeassistant" if settings.homeassistant_url else "demo"
        self._lock = threading.Lock()
        self._devices = {d["id"]: copy.deepcopy(d) for d in demo_data.HOME_DEVICES}
        self._active_scene: str | None = None

    # ---------- Home Assistant ----------
    def _ha_headers(self) -> dict:
        return {"Authorization": f"Bearer {self.s.homeassistant_token}"}

    def _ha_states(self) -> list[dict]:
        return get_json(f"{self.s.homeassistant_url}/api/states", headers=self._ha_headers())

    def _ha_call(self, domain: str, service: str, data: dict) -> None:
        post_json(f"{self.s.homeassistant_url}/api/services/{domain}/{service}", data, headers=self._ha_headers())

    def _ha_snapshot(self) -> dict:
        devices, scenes = [], []
        for st in self._ha_states():
            entity = st["entity_id"]
            domain = entity.split(".", 1)[0]
            attrs = st.get("attributes", {})
            name = attrs.get("friendly_name", entity)
            if domain == "scene":
                scenes.append({"id": entity, "name": name, "icon": "sparkles", "hue": 260, "description": ""})
                continue
            if domain not in HA_DOMAINS:
                continue
            dev = {"id": entity, "name": name, "room": attrs.get("area", "Home"), "type": HA_DOMAINS[domain],
                   "on": st["state"] in ("on", "locked", "playing", "heat", "cool", "auto")}
            if domain == "light":
                dev["brightness"] = round((attrs.get("brightness") or 0) / 2.55)
                if attrs.get("rgb_color"):
                    dev["color"] = _rgb_to_hex(attrs["rgb_color"])
            if domain == "climate":
                dev["target"] = attrs.get("temperature")
                dev["current"] = attrs.get("current_temperature")
            devices.append(dev)
        return {"mode": "homeassistant", "devices": devices, "scenes": scenes, "active_scene": None}

    def _ha_set(self, device_id: str, change: dict) -> None:
        domain = device_id.split(".", 1)[0]
        data = {"entity_id": device_id}
        if domain == "climate" and "target" in change:
            self._ha_call("climate", "set_temperature", {**data, "temperature": change["target"]})
            return
        if domain == "lock":
            self._ha_call("lock", "lock" if change.get("on", True) else "unlock", data)
            return
        on = change.get("on", True)
        if domain == "light" and on:
            if "brightness" in change:
                data["brightness_pct"] = change["brightness"]
            if "color" in change:
                data["rgb_color"] = _hex_to_rgb(change["color"])
        service = "turn_on" if on else "turn_off"
        self._ha_call(domain, service, data)

    # ---------- public API ----------
    def snapshot(self) -> dict:
        if self.mode == "homeassistant":
            try:
                return self._ha_snapshot()
            except Exception as exc:
                log.warning("Home Assistant unavailable: %s", exc)
                return {"mode": "homeassistant-error", "devices": [], "scenes": [], "active_scene": None}
        with self._lock:
            return {
                "mode": "demo",
                "devices": [copy.deepcopy(d) for d in self._devices.values()],
                "scenes": [{k: v for k, v in sc.items() if k != "states"} for sc in demo_data.HOME_SCENES],
                "active_scene": self._active_scene,
            }

    def device(self, device_id: str) -> dict | None:
        return next((d for d in self.snapshot()["devices"] if d["id"] == device_id), None)

    def set_device(self, device_id: str, change: dict) -> dict | None:
        allowed = {k: change[k] for k in ("on", "brightness", "color", "target", "speed") if k in change}
        if self.mode == "homeassistant":
            self._ha_set(device_id, allowed)
            return self.device(device_id)
        with self._lock:
            dev = self._devices.get(device_id)
            if not dev:
                return None
            if "brightness" in allowed:
                allowed["brightness"] = max(1, min(100, int(allowed["brightness"])))
            if "target" in allowed:
                allowed["target"] = round(max(15.0, min(28.0, float(allowed["target"]))), 1)
            dev.update(allowed)
            self._active_scene = None
            return copy.deepcopy(dev)

    def activate_scene(self, scene_id: str) -> dict | None:
        if self.mode == "homeassistant":
            self._ha_call("scene", "turn_on", {"entity_id": scene_id})
            return {"id": scene_id, "name": scene_id}
        scene = next((s for s in demo_data.HOME_SCENES if s["id"] == scene_id), None)
        if not scene:
            return None
        with self._lock:
            for dev_id, state in scene["states"].items():
                if dev_id in self._devices:
                    self._devices[dev_id].update(state)
            self._active_scene = scene_id
        return {k: v for k, v in scene.items() if k != "states"}
