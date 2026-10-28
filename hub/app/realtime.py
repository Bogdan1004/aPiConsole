"""Real-time link between the hub, the consoles (the TV and any browser) and paired phones, over one WebSocket.

- Presence: who is online and what they are doing, pushed to the other players at once.
- Phone as controller: a console asks for a pairing link (shown as a QR code); the phone that opens it gets a key
  for that console only and sends buttons, text and music commands, which are relayed to that console.
- Together: watch and listen parties between players. Invites, play/pause/seek and reactions are relayed between
  the members; each member's player follows the shared state.

Everything is in memory: a hub restart simply makes clients reconnect.
"""

import asyncio
import json
import logging
import secrets
import time
from dataclasses import dataclass, field

from fastapi import WebSocket

from .auth import GUEST

log = logging.getLogger("apistation.realtime")

PAIR_SECONDS = 600
REMOTE_HOURS = 12
MAX_MESSAGES = 40  # per client per second; more is dropped

PHONE_INPUTS = {"up", "down", "left", "right", "a", "b", "x", "y", "lb", "rb", "start", "select"}
REACTIONS = {"heart", "flame", "star", "sparkles", "trophy", "zap"}


@dataclass
class Client:
    ws: WebSocket
    role: str  # "console" or "phone"
    cid: str  # the console's id (for a phone: the console it controls)
    profile_id: str | None = None
    activity: dict = field(default_factory=dict)
    window: list = field(default_factory=lambda: [0.0, 0])  # [second, messages in it]
    tv: bool = False  # the kiosk on the Pi's own screen: its phones drive the virtual gamepad


class Realtime:
    def __init__(self):
        self.consoles: dict[str, Client] = {}
        self.phones: dict[str, list[Client]] = {}
        self.pairings: dict[str, tuple[str, float]] = {}
        self.remote_keys: dict[str, tuple[str, float]] = {}
        self.parties: dict[str, dict] = {}
        self.loop: asyncio.AbstractEventLoop | None = None
        self.names: dict[str, str] = {}  # profile id → name, for messages
        self.pad = None  # VirtualPad for the TV, set by the hub

    # ---------- sending ----------
    @staticmethod
    async def send(client: Client, msg: dict) -> None:
        try:
            await client.ws.send_text(json.dumps(msg))
        except Exception:  # closed meanwhile: the receive loop cleans up
            pass

    async def to_console(self, cid: str, msg: dict) -> None:
        if cid in self.consoles:
            await self.send(self.consoles[cid], msg)

    async def to_phones(self, cid: str, msg: dict) -> None:
        for phone in list(self.phones.get(cid, [])):
            await self.send(phone, msg)

    async def to_profile(self, pid: str, msg: dict, skip: str | None = None) -> None:
        for c in list(self.consoles.values()):
            if c.profile_id == pid and c.cid != skip:
                await self.send(c, msg)

    def notify(self, pid: str | None, msg: dict) -> None:
        """Push a message from ordinary (threaded) hub code: to one profile, or to everyone when pid is None."""
        if not self.loop:
            return
        targets = [c for c in self.consoles.values() if pid is None or c.profile_id == pid]
        for c in targets:
            asyncio.run_coroutine_threadsafe(self.send(c, msg), self.loop)

    def allow(self, client: Client) -> bool:
        now = int(time.time())
        if client.window[0] != now:
            client.window[:] = [now, 0]
        client.window[1] += 1
        return client.window[1] <= MAX_MESSAGES

    # ---------- phone pairing ----------
    def new_pairing(self, cid: str) -> str:
        now = time.time()
        self.pairings = {t: v for t, v in self.pairings.items() if v[1] > now}
        token = secrets.token_urlsafe(9)
        self.pairings[token] = (cid, now + PAIR_SECONDS)
        return token

    def redeem(self, token: str) -> tuple[str, str] | None:
        """A pairing link opened on a phone: (console id, the phone's key for reconnecting). Single use."""
        cid, expires = self.pairings.pop(token, (None, 0))
        if not cid or expires < time.time():
            return None
        key = secrets.token_urlsafe(18)
        self.remote_keys[key] = (cid, time.time() + REMOTE_HOURS * 3600)
        return cid, key

    def console_for_key(self, key: str) -> str | None:
        cid, expires = self.remote_keys.get(key, (None, 0))
        return cid if cid and expires > time.time() else None

    def unpair(self, cid: str) -> int:
        """Forget every phone paired with a console and disconnect them."""
        self.remote_keys = {k: v for k, v in self.remote_keys.items() if v[0] != cid}
        phones = self.phones.pop(cid, [])
        for p in phones:
            asyncio.ensure_future(p.ws.close(code=4403))
        return len(phones)

    # ---------- connections ----------
    async def join(self, client: Client) -> None:
        if client.role == "phone":
            self.phones.setdefault(client.cid, []).append(client)
            await self.to_console(client.cid, {"t": "phones", "count": len(self.phones[client.cid])})
            console = self.consoles.get(client.cid)
            tv = bool(console and console.tv)
            # Created now, not at the first button: games and the console need a moment to notice a new controller.
            pad = tv and bool(self.pad) and self.pad.ensure()
            await self.send(client, {"t": "paired", "profile": self.names.get(console.profile_id) if console else None,
                                     "tv": tv, "pad": pad})
            await self.to_console(client.cid, {"t": "phone-hello"})  # the console answers with its state
        else:
            old = self.consoles.get(client.cid)
            if old:
                asyncio.ensure_future(old.ws.close(code=4409))  # same console reconnected
            self.consoles[client.cid] = client
            await self.send(client, {"t": "hello", "presence": {} if client.profile_id == GUEST else self.presence(),
                                     "phones": len(self.phones.get(client.cid, [])),
                                     "parties": [p for p in self.parties.values() if client.profile_id in p["invited"]]})
            await self.broadcast_presence()

    async def leave(self, client: Client) -> None:
        if client.role == "phone":
            phones = self.phones.get(client.cid, [])
            if client in phones:
                phones.remove(client)
            if not phones and self.pad:
                self.pad.release_all()  # nothing may stay "held" when the phone goes away
            await self.to_console(client.cid, {"t": "phones", "count": len(phones)})
            return
        if self.consoles.get(client.cid) is client:
            del self.consoles[client.cid]
            for party in list(self.parties.values()):
                if client.cid in party["members"]:
                    await self.leave_party(client, party["id"])
            await self.broadcast_presence()

    # ---------- presence ----------
    def presence(self) -> dict:
        out: dict[str, dict] = {}
        for c in self.consoles.values():
            if not c.profile_id or c.profile_id == GUEST:  # visitors stay invisible
                continue
            entry = out.setdefault(c.profile_id, {"online": True, "devices": 0, "activity": None})
            entry["devices"] += 1
            if c.activity and (not entry["activity"] or c.activity.get("at", 0) > entry["activity"].get("at", 0)):
                entry["activity"] = c.activity
        return out

    async def broadcast_presence(self) -> None:
        msg = {"t": "presence", "presence": self.presence()}
        for c in list(self.consoles.values()):
            if c.profile_id != GUEST:  # and don't see who is home
                await self.send(c, msg)

    # ---------- together ----------
    def _party_view(self, party: dict) -> dict:
        return {k: party[k] for k in ("id", "kind", "media", "host", "host_name", "state", "invited")} | {
            "members": [self.consoles[c].profile_id for c in party["members"] if c in self.consoles]}

    async def create_party(self, client: Client, kind: str, media: dict, guests: list[str]) -> None:
        party = {"id": secrets.token_urlsafe(6), "kind": kind, "media": media, "host": client.profile_id,
                 "host_name": self.names.get(client.profile_id, client.profile_id), "members": [client.cid],
                 "invited": guests, "state": {"playing": False, "position": 0, "at": time.time()}}
        self.parties[party["id"]] = party
        await self.send(client, {"t": "party", "party": self._party_view(party)})
        for pid in guests:
            await self.to_profile(pid, {"t": "party-invite", "party": self._party_view(party)})

    async def join_party(self, client: Client, party_id: str) -> None:
        party = self.parties.get(party_id)
        if not party or client.profile_id not in party["invited"] + [party["host"]]:
            await self.send(client, {"t": "party-gone", "id": party_id})
            return
        if client.cid not in party["members"]:
            party["members"].append(client.cid)
        view = self._party_view(party)
        for cid in party["members"]:
            await self.to_console(cid, {"t": "party", "party": view})

    async def leave_party(self, client: Client, party_id: str) -> None:
        party = self.parties.get(party_id)
        if not party or client.cid not in party["members"]:
            return
        party["members"].remove(client.cid)
        if client.profile_id == party["host"] or not party["members"]:
            del self.parties[party_id]  # the host left: the party ends for everyone
            for cid in party["members"]:
                await self.to_console(cid, {"t": "party-gone", "id": party_id, "reason": "host-left"})
            for c in list(self.consoles.values()):  # and the invite disappears for those who didn't join
                if c.profile_id in party["invited"] and c.cid not in party["members"]:
                    await self.send(c, {"t": "party-gone", "id": party_id})
            return
        view = self._party_view(party)
        for cid in party["members"]:
            await self.to_console(cid, {"t": "party", "party": view})

    async def party_relay(self, client: Client, msg: dict) -> None:
        party = self.parties.get(msg.get("id"))
        if not party or client.cid not in party["members"]:
            return
        if msg["t"] == "party-state":
            state = {"playing": bool(msg.get("playing")), "position": float(msg.get("position") or 0),
                     "at": time.time(), "by": client.profile_id}
            if party["kind"] == "listen" and isinstance(msg.get("track"), dict):
                party["media"] = msg["track"]  # the host moved on to another song
                state["track"] = msg["track"]
            party["state"] = state
            out = {"t": "party-state", "id": party["id"], **state}
        elif msg["t"] == "party-react" and msg.get("icon") in REACTIONS:
            out = {"t": "party-react", "id": party["id"], "icon": msg["icon"],
                   "name": self.names.get(client.profile_id, "")}
        else:
            return
        for cid in party["members"]:
            if cid != client.cid:
                await self.to_console(cid, out)

    # ---------- messages ----------
    async def handle(self, client: Client, msg: dict) -> None:
        kind = msg.get("t")
        if client.role == "phone":
            if kind == "input" and msg.get("action") in PHONE_INPUTS:
                down = msg.get("down", True) is not False
                console = self.consoles.get(client.cid)
                # On the TV the phone is a real (virtual) controller, so games there get the buttons too.
                if console and console.tv and self.pad and self.pad.set(msg["action"], down):
                    return
                # Elsewhere the console page gets them; "hold" means releases follow (newer phone pages).
                await self.to_console(client.cid, {"t": "remote", "action": msg["action"], "down": down, "hold": "down" in msg})
            elif kind == "text" and isinstance(msg.get("text"), str):
                await self.to_console(client.cid, {"t": "remote-text", "text": msg["text"][:300],
                                                   "submit": bool(msg.get("submit"))})
            elif kind == "music" and msg.get("cmd") in ("toggle", "next", "prev"):
                await self.to_console(client.cid, {"t": "remote-music", "cmd": msg["cmd"]})
            return
        if client.profile_id == GUEST and kind != "state":
            return  # a visitor's console can use a phone as controller, nothing social
        if kind == "state":  # what the console shows, for its phones
            await self.to_phones(client.cid, {"t": "state", **{k: msg.get(k) for k in ("screen", "typing", "music", "label")}})
        elif kind == "presence" and isinstance(msg.get("activity"), dict):
            a = msg["activity"]
            client.activity = {"text": str(a.get("text", ""))[:120], "kind": a.get("kind"), "at": time.time()}
            await self.broadcast_presence()
        elif kind == "party-create" and msg.get("kind") in ("watch", "listen") and isinstance(msg.get("media"), dict):
            guests = [g for g in msg.get("guests", []) if isinstance(g, str) and g != client.profile_id][:4]
            await self.create_party(client, msg["kind"], msg["media"], guests)
        elif kind == "party-join":
            await self.join_party(client, str(msg.get("id")))
        elif kind == "party-leave":
            await self.leave_party(client, str(msg.get("id")))
        elif kind in ("party-state", "party-react"):
            await self.party_relay(client, msg)
