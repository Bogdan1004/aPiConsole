"""The free assistant: a small model running on the Pi itself (llama.cpp server + Qwen2.5 1.5B).

Talking to it costs nothing and works offline. Commands ("good night", "play Sintel", "play Daft Punk") are
understood by a fast rule-based parser first, so they act instantly and reliably; everything else is a conversation
with the local model, streamed to the console as it writes. Claude is only used for the daily picks (ai.py).
"""

import json
import logging
import re
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime
from typing import Iterator

from .ai import EMOJI, _norm, _part_of_day

log = logging.getLogger("apistation.local_ai")

MODEL_NAME = "Qwen2.5 1.5B"

# Static and first in the prompt, so the server keeps it cached between messages (the Pi processes a long prompt
# slowly; only the new part of each conversation is read again).
KNOWLEDGE = """You are the aPi Assistant, the friendly built-in helper of aPiStation, a home entertainment console that
runs on a Raspberry Pi connected to the TV. You run locally on the Pi, so chatting is free and private.

What aPiStation has:
- Home: a row of tiles (For You, Games, Store, Movies, Music, Smart Home, Friends, Cloud Drive, Trophies, Settings).
- Movies: Netflix-style. Claude recommends films from everything ever released, based on what you watched and rated.
  You can search any film, watch trailers, keep My List and a Watch history, and download free legal films
  (public-domain classics and Blender open movies). Films on the Pi play on the TV or in the laptop browser.
- Music: YouTube Music style. Search any song or artist, Claude's mix of 15 songs, Recently played, Liked songs,
  top charts, and an endless radio that keeps adding similar songs. Full songs play through YouTube's official
  player when a YouTube key is set, otherwise 30-second previews.
- Games: retro classics with RetroArch on the TV (or EmulatorJS in a laptop browser), native Linux games,
  and Pi Snake, a built-in game. The Game Store has free and legal games to download and delete.
- Smart Home: lights, scenes (Movie Night, Party, Good Night, Morning, Focus), heating and locks.
- Friends: two profiles (Bogdan and Alex) who share movies, music and games and see each other's activity.
- Cloud Drive: files stored on the Pi, plus live stats (temperature, CPU, storage).
- Gamification: XP, levels, trophies (up to Platinum), daily quests and day streaks for watching, listening,
  playing, controlling the house and asking for advice.
- Controls: arrows or D-pad to move, A/Enter to select, B/Esc to go back, X to share or like, Y for Claude,
  Start/M for the quick menu, Select/V to pause music, LB/RB (Q/E) for previous/next song.

Things you can make happen if the person types them: "play <movie, game, album, song or artist>",
"movie night lights", "party", "good night", "morning", "focus".

How you answer:
- Be warm and brief: 1 to 3 short sentences, plain text, no emoji, no markdown, no lists unless asked.
- Answer in the same language the person writes in (often Romanian or English).
- Only describe features listed above; if you don't know something, say so instead of guessing.
- When it helps, suggest an exact thing to type, such as "play Sintel" or "good night"."""


# "play X" / "pune X" at the start of the message, as a command (not "what can we play together?").
MUSIC_COMMAND = re.compile(
    r"^(?:please |te rog )?(?:play|listen to|put on|pune(?:-mi| mi)?|porneste|da drumul la|vreau sa ascult|ascult[a]?)"
    r"\s+(?:me |mi |imi |some |ceva |niste |the |muzica |music |melodia |piesa |songs? |de la |by )*(.+?)(?: te rog| please)?[.!?]*$")
NOT_MUSIC = re.compile(r"\b(film|filmul|movie|joc|jocul|game)\b")


def music_command(message: str, music) -> dict | None:
    """'play Daft Punk' → that artist's endless radio; 'play Get Lucky' → the song, then similar songs."""
    text = _norm(message)
    m = MUSIC_COMMAND.match(text)
    if not m or NOT_MUSIC.search(text):
        return None
    query = m.group(1).strip()
    if len(query) < 2:
        return None
    try:
        found = music.search(query)
        artist = next((a for a in found["artists"] if _norm(a["title"]) == query), None)
        if artist:
            return {"title": f"{artist['title']} radio", "tracks": music.radio("", f"ar{artist['artist_id']}", set()),
                    "said": f"starting {artist['title']} radio"}
        if found["tracks"]:
            song = found["tracks"][0]
            return {"title": f"{song['title']} radio", "tracks": [song], "said": f"playing {song['title']} by {song['artist']}"}
    except Exception as exc:
        log.warning("Music command failed: %s", exc)
    return None


class LocalAI:
    def __init__(self, url: str):
        self.url = url.rstrip("/")
        self._ready = False
        self._checked = 0.0
        self._warm_prefix = None

    # ---------- status ----------
    @property
    def ready(self) -> bool:
        if time.time() - self._checked > 10:
            self._checked = time.time()
            try:
                with urllib.request.urlopen(f"{self.url}/health", timeout=1.5) as resp:
                    self._ready = json.loads(resp.read().decode()).get("status") == "ok"
            except Exception:
                self._ready = False
        return self._ready

    @property
    def status(self) -> dict:
        return {"enabled": self.ready, "model": MODEL_NAME, "where": "on this Pi"}

    # ---------- prompt ----------
    @staticmethod
    def _system(catalog: list[dict], home: dict) -> str:
        titles = {"movie": [], "album": [], "game": []}
        for c in catalog:
            if c["kind"] in titles and len(titles[c["kind"]]) < 15:
                titles[c["kind"]].append(c["title"].split(" — ")[0])
        scenes = ", ".join(s["name"] for s in home.get("scenes", []))
        return (f"{KNOWLEDGE}\n\nOn this console right now:\n- Movies on the Pi: {', '.join(titles['movie'])}\n"
                f"- Albums on the Pi: {', '.join(titles['album'])}\n- Games: {', '.join(titles['game'])}\n"
                f"- Smart home scenes: {scenes}")

    @staticmethod
    def _messages(system: str, profile: dict, message: str, chat: list[dict]) -> list[dict]:
        now = datetime.now()
        about = (f"(Talking to {profile['name']}, level {profile['level']} {profile['title']}, "
                 f"{now:%A %H:%M}, {_part_of_day(now)}.)")
        messages = [{"role": "system", "content": f"{system}\n\n{about}"}]
        for turn in chat[-6:]:
            if turn.get("text"):
                role = "assistant" if turn.get("role") == "assistant" else "user"
                messages.append({"role": role, "content": str(turn["text"])[:600]})
        messages.append({"role": "user", "content": message[:600]})
        return messages

    # ---------- chat ----------
    def stream(self, profile: dict, message: str, chat: list[dict], catalog: list[dict], home: dict) -> Iterator[str]:
        """Yields the reply piece by piece; raises if the local model can't be reached."""
        body = {
            "messages": self._messages(self._system(catalog, home), profile, message, chat),
            "stream": True, "max_tokens": 140, "temperature": 0.6, "top_p": 0.9, "repeat_penalty": 1.1,
            "cache_prompt": True,
        }
        req = urllib.request.Request(f"{self.url}/v1/chat/completions", data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=180) as resp:
            for raw in resp:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    delta = json.loads(data)["choices"][0]["delta"].get("content")
                except (json.JSONDecodeError, KeyError, IndexError):
                    continue
                delta = EMOJI.sub("", delta or "").replace("**", "")
                if delta:
                    yield delta

    def warm_up(self, catalog: list[dict], home: dict) -> None:
        """Reads the long, fixed part of the prompt once in the background, so the first question is answered fast."""
        def run():
            # The model may start long after the hub (or restart): wait for it, however long that takes.
            while not self.ready:
                time.sleep(15)
            system = self._system(catalog, home)
            body = {"messages": [{"role": "system", "content": system}, {"role": "user", "content": "Hi"}],
                    "max_tokens": 1, "cache_prompt": True}
            req = urllib.request.Request(f"{self.url}/v1/chat/completions", data=json.dumps(body).encode(),
                                         headers={"Content-Type": "application/json"}, method="POST")
            started = time.time()
            try:
                urllib.request.urlopen(req, timeout=300).read()
                log.info("Local model warmed up in %.0f s", time.time() - started)
            except (urllib.error.URLError, TimeoutError) as exc:
                log.warning("Local model warm-up failed: %s", exc)
        threading.Thread(target=run, daemon=True, name="llm-warmup").start()
