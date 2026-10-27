"""Claude inside the console: daily recommendations and an assistant that can act.

Without ANTHROPIC_API_KEY everything still works through a small offline
"oracle" so the demo never breaks.
"""

import json
import logging
import random
import re
from datetime import date, datetime

import anthropic

from .config import Settings
from .db import Database, dumps

log = logging.getLogger("apistation.ai")

FALLBACK_BETA = "server-side-fallback-2026-07-01"

SYSTEM_PROMPT = """You are the AI built into aPiStation, a home entertainment console running on a Raspberry Pi.
It is a personal cloud: a movie library, a music library, retro and native games, a smart home and file storage.
You talk to the person currently signed in on the TV. Be warm, playful and brief, like a game companion:
short sentences that read well on a TV from the couch. Never invent catalog items: only use the ids listed
in the catalog below. Reply in the same language the person writes in (Romanian or English).
Never use emoji: the TV font cannot display them."""

RECOMMEND_TASK = """Pick 4 items for this person to enjoy right now, mixing kinds (movies, albums, games)
based on their history, the time of day and their level. Favour things they have not tried yet, but
include one "comfort pick" similar to something they liked. For each pick give a one-sentence reason that
refers to their history, and a 1-3 word vibe tag. The headline is a short greeting with a theme for the session.
Also pick up to 6 games for them, from their games (kind "game") or from the free Store (kind "store", not installed
yet), favouring variety and two-player games when it fits, each with a one-sentence reason. Finally pick the smart
home scene that suits this moment, with a one-sentence reason."""

ASSIST_TASK = """Answer the person's message. If they ask you to do something the console can do, add actions:
- "play": start a catalog item (target_id = catalog id)
- "scene": activate a smart home scene (target_id = scene id)
- "device_on" / "device_off": switch one smart home device (target_id = device id)
Only add actions the person asked for or clearly implied. Use an empty list otherwise."""

FILM_TASK = """Recommend films for this person to watch next, chosen from all films ever released (not only
what is on the console). Base it on what they watched, liked and disliked, and on their list. Never suggest a film
they already watched or already have on their list. Mix well-known favourites with a few hidden gems, and vary decades
and countries. Give exactly 10 top picks, plus one "because you watched" set of 6 films tied to the watched film that
says the most about their taste. Each reason is one short sentence in English that refers to their history.
Use the English title exactly as IMDb lists it, and the release year, so the film can be found."""

MUSIC_TASK = """Recommend songs for this person to listen to next, chosen from all music ever released (not only
what is on the console). Base it on the artists they play most and the songs they liked and disliked; if there is
little history, use the time of day and pick widely loved songs. Never suggest a song they already played or
disliked. Mix artists they love with new artists in the same spirit and vary the eras. Give exactly 15 songs, at most
2 by the same artist, ordered so they flow as one playlist, and a short catchy playlist name as the headline. Each
reason is one short sentence in English that refers to their taste. Use the song title and main artist exactly as
streaming services list them, so the song can be found."""

SONG = {
    "type": "object",
    "properties": {"artist": {"type": "string"}, "title": {"type": "string"}, "reason": {"type": "string"}},
    "required": ["artist", "title", "reason"],
    "additionalProperties": False,
}
MUSIC_SCHEMA = {
    "type": "object",
    "properties": {"headline": {"type": "string"}, "songs": {"type": "array", "items": SONG}},
    "required": ["headline", "songs"],
    "additionalProperties": False,
}

PICK = {
    "type": "object",
    "properties": {"title": {"type": "string"}, "year": {"type": "integer"}, "reason": {"type": "string"}},
    "required": ["title", "year", "reason"],
    "additionalProperties": False,
}
FILM_SCHEMA = {
    "type": "object",
    "properties": {
        "headline": {"type": "string"},
        "top": {"type": "array", "items": PICK},
        "because": {
            "type": "object",
            "properties": {"watched_title": {"type": "string"}, "picks": {"type": "array", "items": PICK}},
            "required": ["watched_title", "picks"],
            "additionalProperties": False,
        },
    },
    "required": ["headline", "top", "because"],
    "additionalProperties": False,
}

RECOMMEND_SCHEMA = {
    "type": "object",
    "properties": {
        "headline": {"type": "string"},
        "picks": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "item_id": {"type": "string"},
                    "kind": {"type": "string", "enum": ["movie", "album", "game"]},
                    "reason": {"type": "string"},
                    "vibe": {"type": "string"},
                },
                "required": ["item_id", "kind", "reason", "vibe"],
                "additionalProperties": False,
            },
        },
        "games": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "item_id": {"type": "string"},
                    "kind": {"type": "string", "enum": ["game", "store"]},
                    "reason": {"type": "string"},
                },
                "required": ["item_id", "kind", "reason"],
                "additionalProperties": False,
            },
        },
        "scene": {
            "type": "object",
            "properties": {"scene_id": {"type": "string"}, "reason": {"type": "string"}},
            "required": ["scene_id", "reason"],
            "additionalProperties": False,
        },
    },
    "required": ["headline", "picks", "games", "scene"],
    "additionalProperties": False,
}

ASSIST_SCHEMA = {
    "type": "object",
    "properties": {
        "reply": {"type": "string"},
        "actions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "type": {"type": "string", "enum": ["play", "scene", "device_on", "device_off"]},
                    "target_id": {"type": "string"},
                },
                "required": ["type", "target_id"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["reply", "actions"],
    "additionalProperties": False,
}


# The console font has no emoji glyphs; drop them (and joiners/variation selectors) if any slip through.
EMOJI = re.compile("[\U0001F000-\U0001FAFF\u2600-\u27BF\u2B00-\u2BFF\uFE0F\u200D]+")


def _clean(text: str) -> str:
    return re.sub(r"\s{2,}", " ", EMOJI.sub("", text)).strip()


def _part_of_day(now: datetime) -> str:
    h = now.hour
    return "morning" if 5 <= h < 12 else "afternoon" if h < 18 else "evening" if h < 23 else "late night"


class AI:
    def __init__(self, settings: Settings, db: Database):
        self.s = settings
        self.db = db
        self.client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key) if settings.ai_enabled else None
        self._use_fallbacks = True
        self.last_error: str | None = None

    @property
    def status(self) -> dict:
        return {"enabled": self.client is not None, "model": self.s.claude_model if self.client else None,
                "last_error": self.last_error}

    # ---------- Claude ----------
    def _system(self, catalog: list[dict], home: dict) -> list[dict]:
        home_digest = {
            "scenes": [{"id": s["id"], "name": s["name"]} for s in home.get("scenes", [])],
            "devices": [{"id": d["id"], "name": d["name"], "type": d["type"]} for d in home.get("devices", [])],
        }
        context = f"<catalog>\n{dumps(catalog)}\n</catalog>\n<smart_home>\n{dumps(home_digest)}\n</smart_home>"
        return [{"type": "text", "text": SYSTEM_PROMPT}, {"type": "text", "text": context}]

    async def _ask(self, system: list[dict], messages: list[dict], schema: dict) -> dict | None:
        kwargs = {
            "model": self.s.claude_model,
            "max_tokens": 16000,
            "system": system,
            "messages": messages,
            "output_config": {"effort": "low", "format": {"type": "json_schema", "schema": schema}},
            "cache_control": {"type": "ephemeral"},
        }
        try:
            try:
                if self._use_fallbacks:
                    resp = await self.client.beta.messages.create(**kwargs, betas=[FALLBACK_BETA], fallbacks="default")
                else:
                    resp = await self.client.messages.create(**kwargs)
            except anthropic.BadRequestError as exc:
                if not self._use_fallbacks:
                    raise
                log.warning("Retrying without server-side fallbacks: %s", exc.message)
                self._use_fallbacks = False
                resp = await self.client.messages.create(**kwargs)
        except anthropic.AuthenticationError:
            self.last_error = "Invalid ANTHROPIC_API_KEY"
        except anthropic.RateLimitError:
            self.last_error = "Rate limited, try again in a minute"
        except anthropic.APIStatusError as exc:
            self.last_error = f"Claude API error {exc.status_code}"
            log.warning("Claude API error %s: %s", exc.status_code, exc.message)
        except anthropic.APIConnectionError:
            self.last_error = "No connection to the Claude API"
        else:
            if resp.stop_reason == "refusal":
                self.last_error = "Claude declined this request"
                return None
            if resp.stop_reason == "max_tokens":
                self.last_error = "Claude's answer was cut off"
                return None
            text = next((b.text for b in resp.content if b.type == "text"), None)
            try:
                data = json.loads(text) if text else None
            except json.JSONDecodeError:
                data = None
            if data is None:
                self.last_error = f"Unreadable response ({resp.stop_reason})"
                return None
            self.last_error = None
            log.info("Claude usage: in=%s cached=%s out=%s", resp.usage.input_tokens,
                     resp.usage.cache_read_input_tokens, resp.usage.output_tokens)
            return data
        return None

    # ---------- recommendations ----------
    async def recommendations(self, profile: dict, history: list[dict], catalog: list[dict],
                              home: dict, refresh: bool = False) -> dict:
        today = date.today().isoformat()
        if not refresh:
            cached = self.db.one("SELECT payload FROM ai_cache WHERE profile_id=? AND day=? AND kind='recs'",
                                 (profile["id"], today))
            if cached:
                return json.loads(cached["payload"])

        result = None
        if self.client:
            now = datetime.now()
            user = (
                f"{RECOMMEND_TASK}\n\n<person>\nname: {profile['name']}\nlevel: {profile['level']} ({profile['title']})\n"
                f"time: {now:%A %H:%M} ({_part_of_day(now)})\n</person>\n"
                f"<recent_history>\n{dumps(_history_digest(history))}\n</recent_history>"
            )
            data = await self._ask(self._system(catalog, home), [{"role": "user", "content": user}], RECOMMEND_SCHEMA)
            if data:
                ids = {(c["kind"], c["id"]) for c in catalog}
                picks = [{**p, "reason": _clean(p["reason"]), "vibe": _clean(p["vibe"])}
                         for p in data["picks"] if (p["kind"], p["item_id"]) in ids][:5]
                games = [{**g, "reason": _clean(g["reason"])} for g in data["games"] if (g["kind"], g["item_id"]) in ids][:6]
                scenes = {s["id"] for s in home.get("scenes", [])}
                scene = data["scene"] if data["scene"]["scene_id"] in scenes else None
                if picks:
                    result = {"source": "claude", "model": self.s.claude_model, "headline": _clean(data["headline"]),
                              "picks": picks, "games": games or offline_games(profile, history, catalog),
                              "scene": scene and {**scene, "reason": _clean(scene["reason"])} or offline_scene(home)}
        if result is None:
            result = offline_recommendations(profile, history, catalog, home)
            result["error"] = self.last_error if self.client else None

        result["generated_at"] = datetime.now().isoformat(timespec="minutes")
        with self.db.write() as conn:
            conn.execute("INSERT OR REPLACE INTO ai_cache(profile_id, day, kind, payload) VALUES (?,?,?,?)",
                         (profile["id"], today, "recs", dumps(result)))
        return result

    # ---------- films ----------
    async def film_picks(self, profile: dict, watched: list[dict], listed: list[dict], genres: list[str]) -> dict | None:
        """Claude's picks from all films (titles + years); None when Claude is off or failed."""
        if not self.client:
            return None
        def line(f):
            mood = {1: "liked", -1: "disliked"}.get(f.get("rating_given", 0), "watched")
            return {"title": f["title"], "year": f.get("year"), "genres": f.get("genres", [])[:3], "verdict": mood}
        user = (
            f"{FILM_TASK}\n\n<person>\nname: {profile['name']}\nfavourite genres: {', '.join(genres)}\n</person>\n"
            f"<watched>\n{dumps([line(f) for f in watched[:60]])}\n</watched>\n"
            f"<my_list>\n{dumps([{'title': f['title'], 'year': f.get('year')} for f in listed[:30]])}\n</my_list>"
        )
        system = [{"type": "text", "text": SYSTEM_PROMPT}]
        return await self._ask(system, [{"role": "user", "content": user}], FILM_SCHEMA)

    # ---------- music ----------
    async def music_picks(self, profile: dict, history: list[dict], liked: list[dict], disliked: list[dict],
                          top_artists: list[str]) -> dict | None:
        """Claude's playlist from all music (artist + title); None when Claude is off or failed."""
        if not self.client:
            return None
        now = datetime.now()
        song = lambda t: {"artist": t["artist"], "title": t["title"]}
        user = (
            f"{MUSIC_TASK}\n\n<person>\nname: {profile['name']}\ntime: {now:%A %H:%M} ({_part_of_day(now)})\n"
            f"most played artists: {', '.join(top_artists) or 'none yet'}\n</person>\n"
            f"<played>\n{dumps([{**song(t), 'plays': t['plays']} for t in history[:50]])}\n</played>\n"
            f"<liked>\n{dumps([song(t) for t in liked[:40]])}\n</liked>\n"
            f"<disliked>\n{dumps([song(t) for t in disliked[:20]])}\n</disliked>"
        )
        system = [{"type": "text", "text": SYSTEM_PROMPT}]
        return await self._ask(system, [{"role": "user", "content": user}], MUSIC_SCHEMA)

    # ---------- assistant ----------
    async def assistant(self, profile: dict, message: str, history: list[dict], chat: list[dict],
                        catalog: list[dict], home: dict) -> dict:
        if self.client:
            now = datetime.now()
            context = (
                f"{ASSIST_TASK}\n\n<person>\nname: {profile['name']}\nlevel: {profile['level']}\n"
                f"time: {now:%A %H:%M}\n</person>\n<recent_history>\n{dumps(_history_digest(history)[:10])}\n</recent_history>"
            )
            messages = [{"role": "user", "content": context}, {"role": "assistant", "content": "Ready."}]
            for turn in chat[-6:]:
                role = "assistant" if turn.get("role") == "assistant" else "user"
                if turn.get("text"):
                    messages.append({"role": role, "content": str(turn["text"])[:1000]})
            messages.append({"role": "user", "content": message[:1000]})
            messages = _merge_roles(messages)
            data = await self._ask(self._system(catalog, home), messages, ASSIST_SCHEMA)
            if data:
                return {"source": "claude", "model": self.s.claude_model, **data, "reply": _clean(data["reply"])}
        result = offline_assistant(profile, message, catalog, home)
        result["error"] = self.last_error if self.client else None
        return result


def _merge_roles(messages: list[dict]) -> list[dict]:
    """The API needs alternating roles; join consecutive same-role turns."""
    merged: list[dict] = []
    for m in messages:
        if merged and merged[-1]["role"] == m["role"]:
            merged[-1] = {"role": m["role"], "content": f"{merged[-1]['content']}\n\n{m['content']}"}
        else:
            merged.append(m)
    return merged


def _history_digest(history: list[dict]) -> list[dict]:
    return [{"kind": h["kind"], "title": h["title"], "when": h["ts"]}
            for h in history if h["kind"] in ("watch", "listen", "play", "score") and h.get("title")][:25]


# ---------- offline oracle ----------
KIND_OF_ACTIVITY = {"watch": "movie", "listen": "album", "play": "game"}


def offline_games(profile: dict, history: list[dict], catalog: list[dict]) -> list[dict]:
    """Games not played lately first, then featured free games from the Store."""
    played = {h.get("item_id") for h in history if h["kind"] == "play"}
    rng = random.Random(f"{profile['id']}:games:{date.today()}")
    mine = [c for c in catalog if c["kind"] == "game" and c["id"] not in played]
    shop = [c for c in catalog if c["kind"] == "store"]
    rng.shuffle(mine)
    rng.shuffle(shop)
    out = [{"item_id": c["id"], "kind": "game", "reason": "In your library and not played lately."} for c in mine[:3]]
    for c in shop[:6 - len(out)]:
        two = str(c.get("players") or "1") != "1"  # "1-2", "2-4"…
        out.append({"item_id": c["id"], "kind": "store",
                    "reason": "Free in the Store" + (", and you can play it together." if two else ", one download away.")})
    return out


SCENE_FOR_HOUR = [(5, "morning", "A bright start to the day."), (9, "focus", "Daylight hours: good for getting things done."),
                  (18, "movie_night", "Evening is here: dim the lights for a film."), (23, "good_night", "It's late, time to wind down.")]


def offline_scene(home: dict | None) -> dict | None:
    scenes = {s["id"] for s in (home or {}).get("scenes", [])}
    hour = datetime.now().hour
    pick = SCENE_FOR_HOUR[-1]
    for start, scene_id, reason in SCENE_FOR_HOUR:
        if hour >= start:
            pick = (start, scene_id, reason)
    return {"scene_id": pick[1], "reason": pick[2]} if pick[1] in scenes else None


def offline_recommendations(profile: dict, history: list[dict], catalog: list[dict], home: dict | None = None) -> dict:
    taste: dict[str, int] = {}
    seen: set[tuple[str, str]] = set()
    liked: dict[str, str] = {}
    for h in history:
        kind = KIND_OF_ACTIVITY.get(h["kind"])
        if not kind:
            continue
        seen.add((kind, h.get("item_id")))
        item = next((c for c in catalog if c["kind"] == kind and c["id"] == h.get("item_id")), None)
        for tag in (item or {}).get("tags", []):
            if tag:
                taste[tag] = taste.get(tag, 0) + 1
                liked.setdefault(tag, item["title"].split(" — ")[0])

    rng = random.Random(f"{profile['id']}:{date.today()}")

    def score(c):
        return sum(taste.get(t, 0) for t in c.get("tags", []) if t) + rng.random() * 1.5 - (2 if (c["kind"], c["id"]) in seen else 0)

    picks = []
    for kind, count in (("movie", 2), ("album", 1), ("game", 1)):
        pool = sorted((c for c in catalog if c["kind"] == kind), key=score, reverse=True)[:count]
        for c in pool:
            tag = next((t for t in c.get("tags", []) if t in liked), None)
            if tag and liked[tag] != c["title"].split(" — ")[0]:
                reason = f"You enjoyed {liked[tag]}, and this is more {tag if tag.isupper() else tag.lower()}."
            elif (c["kind"], c["id"]) in seen:
                reason = "A comfort pick you already know and like."
            else:
                tags = ", ".join(t for t in c.get("tags", []) if t)
                reason = f"Something new for your collection: {tags.lower()}."
            picks.append({"item_id": c["id"], "kind": c["kind"], "reason": reason,
                          "vibe": (c.get("tags") or ["Fresh"])[0] or "Fresh"})
    part = _part_of_day(datetime.now())
    return {"source": "offline", "model": None,
            "headline": f"Good {part if part != 'late night' else 'night'}, {profile['name']}! Here's your lineup.",
            "picks": picks, "games": offline_games(profile, history, catalog), "scene": offline_scene(home)}


SCENE_WORDS = {
    "movie_night": ["movie night", "movie lights", "cinema mode", "lumina de film", "lumini de film"],
    "party": ["party", "petrecere"],
    "good_night": ["good night", "noapte buna", "noapte bună", "sleep", "somn", "culcare"],
    "morning": ["morning", "dimineata", "dimineața", "coffee", "cafea"],
    "focus": ["focus", "work", "study", "lucru", "invat", "învăț"],
}
PLAY_WORDS = ["play", "watch", "listen", "start", "launch", "pune", "porneste", "pornește", "joaca", "joacă", "ascult"]


def _norm(text: str) -> str:
    table = str.maketrans("ăâîșşțţ", "aaisstt")
    return re.sub(r"\s+", " ", text.lower().translate(table)).strip()


def offline_assistant(profile: dict, message: str, catalog: list[dict], home: dict) -> dict:
    text = _norm(message)
    actions, said = [], []
    scene_ids = {s["id"]: s["name"] for s in home.get("scenes", [])}
    for scene_id, words in SCENE_WORDS.items():
        if scene_id in scene_ids and any(_norm(w) in text for w in words):
            actions.append({"type": "scene", "target_id": scene_id})
            said.append(f"switching the house to {scene_ids[scene_id]}")
            break
    if any(w in text for w in PLAY_WORDS):
        for c in catalog:
            title = _norm(c["title"].split(" — ")[0])
            words = [w for w in re.findall(r"[a-z0-9]+", title) if len(w) > 3]
            if title in text or (words and all(w in text for w in words)):
                actions.append({"type": "play", "target_id": c["id"]})
                said.append(f"starting {c['title'].split(' — ')[0]}")
                break
    if said:
        reply = f"On it, {profile['name']}: " + " and ".join(said) + "."
    else:
        reply = ("I'm running in offline mode right now, so my answers are limited. "
                 "Try: \"movie night lights\", \"play Sintel\" or \"good night\". "
                 "Add an ANTHROPIC_API_KEY to the hub to unlock Claude.")
    return {"source": "offline", "model": None, "reply": reply, "actions": actions}
