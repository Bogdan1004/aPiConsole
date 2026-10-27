"""aPiStation Hub: one API for media, games, smart home, storage, gamification and Claude."""

import ipaddress
import json
import logging
import socket
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import date

from fastapi import FastAPI, HTTPException, Request, Response
from starlette.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .ai import AI, offline_assistant, offline_games, offline_recommendations, offline_scene
from .auth import COOKIE, GUEST, PIN_RE, Auth, Session, client_address, current
from .assistant_faq import answer as faq_answer
from .local_ai import MODEL_NAME, LocalAI, music_command
from .config import settings
from .db import Database
from .gamification import Gamification
from .seed import seed
from .services import system
from .services.home import SmartHome
from .services.launcher import Launcher
from .services.library import Library
from .services.drive import Drive, DriveError
from .services.films import Films
from .services.music import Music
from .services.store import Store
from .store_catalog import STORE_BY_ID

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

db = Database(settings.db_path)
seed(db)
auth = Auth(db)  # also adds the Guest profile
game = Gamification(db)
library = Library(settings)
home = SmartHome(settings)
launcher = Launcher(settings)
ai = AI(settings, db)
local_ai = LocalAI(settings.local_llm_url)


def _store_finished(job: dict) -> None:
    library.invalidate_games()
    if job["action"] == "install" and job["state"] == "done" and job.get("profile_id"):
        job["event"] = game.record(job["profile_id"], "install", job["id"], job["title"], {})


store = Store(settings, _store_finished)
films = Films(settings, db, on_files_changed=library.invalidate_movies)
library.extra_movies = films.local_movies
music = Music(settings, db)
local_ai.warm_up(library.catalog_digest(), home.snapshot())
drive = Drive(settings.storage_root, db, db.all("SELECT id, name FROM profiles ORDER BY rowid"))

app = FastAPI(title="aPiStation Hub", version="0.1.0")

PLAY_KIND = {"movie": "watch", "album": "listen", "game": "play"}


@app.middleware("http")
async def sessions_and_limits(request: Request, call_next):
    """Who is asking (session cookie), what they may do (guest = read-only) and how often."""
    session = auth.lookup(request.cookies.get(COOKIE))
    current.set(session)
    method, path = request.method, request.url.path
    if not auth.is_public(method, path):
        if not session:
            return JSONResponse({"detail": "Sign in first", "code": "signin"}, status_code=401)
        if session.guest and not auth.guest_may(method, path):
            return JSONResponse({"detail": "Guests can look around, but can't change things on this console.",
                                 "code": "guest"}, status_code=403)
        if not auth.allow(session, "requests"):
            return JSONResponse({"detail": "Too many requests, slow down a little.", "code": "rate"}, status_code=429)
    return await call_next(request)


@app.middleware("http")
async def no_stale_console(request: Request, call_next):
    response = await call_next(request)
    if not request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


def _known(pid: str) -> None:
    if not db.scalar("SELECT 1 FROM profiles WHERE id=?", (pid,)):
        raise HTTPException(404, f"Unknown profile {pid}")


def _profile(pid: str, others: bool = False) -> dict:
    """The signed-in profile's summary. `others`: a signed-in player may also read the other player's."""
    session = current.get()
    if not session:
        raise HTTPException(401, "Sign in first")
    if pid != session.profile_id and not (others and not session.guest and pid != GUEST):
        raise HTTPException(403, "That's another profile")
    _known(pid)
    return game.summary(pid)


def _guest() -> bool:
    session = current.get()
    return bool(session and session.guest)


def _claude_refresh(refresh: bool) -> bool:
    """Forced new picks cost money: limited per hour (guests never get Claude at all)."""
    if refresh and not auth.allow(current.get(), "claude"):
        raise HTTPException(429, "That's a lot of new picks for one hour. Try again later.")
    return refresh


def _from_home(request: Request) -> bool:
    """Directly from the home network (not through a tunnel, which would add forwarding headers)."""
    if any(request.headers.get(h) for h in ("cf-connecting-ip", "x-forwarded-for", "forwarded")):
        return False
    try:
        address = ipaddress.ip_address(request.client.host)
    except (ValueError, AttributeError):
        return False
    return address.is_private or address.is_loopback


def _item(kind: str, item_id: str) -> dict:
    item = library.find(kind, item_id)
    if not item:
        raise HTTPException(404, f"Unknown {kind} {item_id}")
    return item


def _play_meta(item: dict) -> dict:
    if item["kind"] == "movie":
        return {"genres": item.get("genres", [])}
    if item["kind"] == "album":
        return {"genre": item.get("genre"), "artist": item.get("artist")}
    return {"platform": item.get("platform")}


# ---------- system ----------
@app.get("/api/health")
def health():
    return {"name": "aPiStation", "version": app.version, "role": settings.role, "ai": ai.status,
            "assistant": local_ai.status,
            "hostname": socket.gethostname().lower(),
            "services": {**library.status, "home": home.mode}}


@app.get("/api/system")
def system_stats():
    return system.stats(settings.storage_root)


# ---------- profiles & gamification ----------
@app.get("/api/profiles")
def profiles():
    """The profile picker (public): Guest last."""
    rows = db.all("SELECT id FROM profiles ORDER BY id = ?, rowid", (GUEST,))
    return [{**game.summary(r["id"]), "guest": r["id"] == GUEST, "has_pin": auth.has_pin(r["id"])} for r in rows]


class LoginRequest(BaseModel):
    pin: str = Field(default="", max_length=6)
    remember: bool = True


def _https(request: Request) -> bool:
    return request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"


@app.post("/api/profiles/{pid}/login")
def login(pid: str, request: Request, response: Response, req: LoginRequest | None = None):
    """Signs in with the profile's PIN (Guest needs none) and sets the session cookie."""
    req = req or LoginRequest()
    _known(pid)
    if pid != GUEST:
        if not auth.has_pin(pid):
            raise HTTPException(409, "Create a PIN for this profile first")
        address = client_address(request.headers, request.client)
        if auth.pin_locked(pid, address):
            raise HTTPException(429, "Too many wrong PINs. Try again in a few minutes.")
        if not auth.check_pin(pid, req.pin):
            auth.pin_failed(pid, address)
            raise HTTPException(403, "Wrong PIN")
    token, max_age = auth.start(pid, req.remember)
    response.set_cookie(COOKIE, token, max_age=max_age if req.remember or pid == GUEST else None,
                        httponly=True, samesite="lax", secure=_https(request), path="/")
    current.set(Session(pid, 0))
    return {**game.login(pid), "guest": pid == GUEST}


class PinRequest(BaseModel):
    pin: str = Field(pattern=PIN_RE.pattern)
    old_pin: str = Field(default="", max_length=6)


@app.post("/api/profiles/{pid}/pin")
def set_pin(pid: str, req: PinRequest, request: Request):
    """First PIN: only from the home network. Changing it: signed in as that profile, with the current PIN."""
    _known(pid)
    if pid == GUEST:
        raise HTTPException(400, "The Guest profile has no PIN")
    if not auth.has_pin(pid):
        if not _from_home(request):
            raise HTTPException(403, "Create the first PIN from the home network")
    else:
        session = current.get()
        if not session or session.profile_id != pid:
            raise HTTPException(403, "Sign in to change your PIN")
        address = client_address(request.headers, request.client)
        if auth.pin_locked(pid, address):
            raise HTTPException(429, "Too many wrong PINs. Try again in a few minutes.")
        if not auth.check_pin(pid, req.old_pin):
            auth.pin_failed(pid, address)
            raise HTTPException(403, "The current PIN is wrong")
    auth.set_pin(pid, req.pin)
    return {"ok": True}


@app.get("/api/session")
def session_info():
    session = current.get()
    if not session:
        return {"signed_in": False}
    return {"signed_in": True, "guest": session.guest, "profile": game.summary(session.profile_id)}


@app.post("/api/session/logout")
def logout(request: Request, response: Response):
    auth.end(request.cookies.get(COOKIE))
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}


@app.get("/api/profiles/{pid}")
def profile(pid: str):
    return {**_profile(pid, others=True), "quests": game.daily_quests(pid)}


@app.get("/api/profiles/{pid}/trophies")
def trophies(pid: str):
    _profile(pid, others=True)
    return game.trophies(pid)


@app.get("/api/profiles/{pid}/activity")
def activity(pid: str, limit: int = 30):
    _profile(pid, others=True)
    return game.activity(pid, limit)


@app.get("/api/feed")
def feed(limit: int = 30):
    """Everyone's activity for players; a guest only sees its own (and players never see the guest's)."""
    if _guest():
        return game.activity(GUEST, limit)
    return [a for a in game.activity(None, limit + 40) if a["profile_id"] != GUEST][:limit]


# ---------- library & playback ----------
@app.get("/api/library/movies")
def movies():
    return library.movies()


@app.get("/api/library/albums")
def albums():
    return library.albums()


@app.get("/api/library/games")
def games():
    return library.games()


class PlayRequest(BaseModel):
    profile_id: str
    kind: str = Field(pattern="^(movie|album|game)$")
    item_id: str
    # "tv": native player/emulator on the Pi's HDMI screen; "here": in the requesting browser (EmulatorJS)
    target: str = Field(default="tv", pattern="^(tv|here)$")


@app.post("/api/play")
def play(req: PlayRequest):
    _profile(req.profile_id)
    item = _item(req.kind, req.item_id)
    in_browser = (req.target == "here" and (item.get("web") or item.get("imdb_id"))) or item["kind"] == "album" \
        or (item["kind"] == "game" and item["launch"]["type"] == "builtin")
    if _guest() and not in_browser:
        raise HTTPException(403, "Guests play in the browser; the TV is for signed-in players.")
    if req.target == "here" and item.get("web"):
        launch = {"mode": "web", **item["web"]}
    elif req.target == "here" and item["kind"] == "movie" and item.get("imdb_id"):
        # A downloaded film plays in the requesting browser, streamed from the Pi.
        launch = {"mode": "web-video", "url": f"/api/films/{item['imdb_id']}/stream"}
    else:
        launch = launcher.launch(item)
    tracks = library.album_streams(item) if item["kind"] == "album" else None
    event = game.record(req.profile_id, PLAY_KIND[req.kind], item["id"], item["title"], _play_meta(item))
    if item.get("imdb_id"):
        films.mark_watched(req.profile_id, {**item, "id": item["imdb_id"]}, 0, "played")
    elif item["kind"] == "movie":
        # Demo / Jellyfin films: find them in the catalog in the background so watch history is complete.
        def log_history(pid=req.profile_id, movie=item):
            found = films.lookup(movie["title"], movie.get("year"))
            if found:
                films.mark_watched(pid, found, 0, "played")
        threading.Thread(target=log_history, daemon=True).start()
    return {"item": item, "launch": launch, "tracks": tracks, "event": event}


class ScoreRequest(BaseModel):
    profile_id: str
    game_id: str
    score: int = Field(ge=0, le=10_000)


@app.post("/api/games/score")
def submit_score(req: ScoreRequest):
    _profile(req.profile_id)
    item = _item("game", req.game_id)
    best = db.scalar("SELECT MAX(CAST(json_extract(meta, '$.score') AS INTEGER)) FROM activity "
                     "WHERE profile_id=? AND kind='score' AND item_id=?", (req.profile_id, req.game_id)) or 0
    event = game.record(req.profile_id, "score", item["id"], item["title"], {"score": req.score})
    return {"best": max(best, req.score), "new_best": req.score > best, "event": event}


@app.get("/api/roms/{game_id}/{filename}")
def rom_file(game_id: str, filename: str):
    path = library.rom_path(game_id)
    if not path:
        raise HTTPException(404, "No ROM for this game")
    return FileResponse(path, media_type="application/octet-stream", filename=path.name)


@app.get("/api/covers/{name}")
def cover_image(name: str):
    path = library.covers.path(name)
    if not path:
        raise HTTPException(404, "No cover")
    return FileResponse(path, media_type="image/png")


@app.post("/api/library/games/{game_id}/delete")
def delete_game(game_id: str):
    if not library.delete_rom(game_id):
        raise HTTPException(400, "Only ROMs you added yourself can be deleted here; Store games are removed in the Store")
    return {"ok": True}


# ---------- Movies (Netflix style) ----------
def _film(fid: str) -> dict:
    info = films.details(fid)
    if not info:
        raise HTTPException(404, f"Unknown film {fid}")
    return info


@app.get("/api/films/home")
def films_home(profile_id: str):
    _profile(profile_id)
    genres = films.favorite_genres(profile_id)
    rows = [
        {"id": "watched", "title": "Watch history", "icon": "clock", "items": films.watched(profile_id)},
        {"id": "local", "title": "On your Pi", "icon": "drive", "items": library.movies()},
        {"id": "mylist", "title": "My List", "icon": "plus", "items": films.my_list(profile_id)},
        {"id": "free", "title": "Free & legal to download", "icon": "download", "items": films.free_ready()},
        {"id": "popular", "title": "Popular right now", "icon": "flame", "items": films.catalog("top")[:30]},
        *({"id": f"genre-{g}", "title": f"Top rated {g}", "icon": "star", "items": films.catalog("imdbRating", g)[:30]}
          for g in genres[:2]),
    ]
    return {"rows": [r for r in rows if r["items"]], "genres": genres, "jobs": films.active_jobs()}


def _resolve_picks(picks: list[dict], seen: set[str]) -> list[dict]:
    with ThreadPoolExecutor(max_workers=6) as pool:
        found = list(pool.map(lambda p: films.lookup(p["title"], p.get("year")), picks))
    out = []
    for pick, film in zip(picks, found):
        if film and film["id"] not in seen:
            seen.add(film["id"])
            out.append({**film, "reason": pick["reason"]})
    return out


@app.get("/api/films/picks")
async def film_picks(profile_id: str, refresh: bool = False):
    prof = _profile(profile_id)
    today = date.today().isoformat()
    cached = db.one("SELECT payload FROM ai_cache WHERE profile_id=? AND day=? AND kind='films'", (profile_id, today))
    if cached and not _claude_refresh(refresh):
        return json.loads(cached["payload"])
    watched, listed = films.watched(profile_id), films.my_list(profile_id)
    genres = films.favorite_genres(profile_id)
    seen = {f["id"] for f in watched} | {f["id"] for f in listed}
    data = None if _guest() else await ai.film_picks(prof, watched, listed, genres)
    if data:
        top = await run_in_threadpool(_resolve_picks, data["top"], seen)
        because = await run_in_threadpool(_resolve_picks, data["because"]["picks"], seen)
        result = {"source": "claude", "headline": data["headline"], "top": top,
                  "because": {"title": f"Because you watched {data['because']['watched_title']}", "items": because}}
    else:
        top = []
        for g in genres:
            for film in await run_in_threadpool(films.catalog, "imdbRating", g):
                if film["id"] not in seen and len(top) < 12:
                    seen.add(film["id"])
                    top.append({**film, "reason": f"One of the best rated {g} films you haven't marked as watched."})
        result = {"source": "offline", "headline": f"Top rated picks in {', '.join(genres)}", "top": top,
                  "because": None, "error": ai.last_error if ai.status["enabled"] else None}
    with db.write() as conn:
        conn.execute("INSERT OR REPLACE INTO ai_cache(profile_id, day, kind, payload) VALUES (?,?,?,?)",
                     (profile_id, today, "films", json.dumps(result)))
    return result


@app.get("/api/films/search")
def film_search(q: str):
    try:
        return films.search(q)
    except Exception as exc:
        raise HTTPException(502, f"Search unavailable: {exc}")


@app.get("/api/films/jobs")
def film_jobs():
    return films.active_jobs()


@app.get("/api/films/{fid}")
def film_details(fid: str, profile_id: str):
    _profile(profile_id)
    info = _film(fid)
    status = films.status(profile_id, fid)
    free = None if status["local"] else films.free_source(info)
    return {**info, "status": status, "free": free}


class FilmAction(BaseModel):
    profile_id: str
    rating: int = Field(default=0, ge=-1, le=1)


@app.post("/api/films/{fid}/watched")
def film_watched(fid: str, req: FilmAction):
    _profile(req.profile_id)
    info = _film(fid)
    films.mark_watched(req.profile_id, info, req.rating, "manual")
    event = game.record(req.profile_id, "rate", fid, info["title"], {"rating": req.rating}) if req.rating else None
    return {"status": films.status(req.profile_id, fid), "event": event}


@app.delete("/api/films/{fid}/watched")
def film_unwatch(fid: str, profile_id: str):
    _profile(profile_id)
    films.unwatch(profile_id, fid)
    return {"status": films.status(profile_id, fid)}


@app.post("/api/films/{fid}/list")
def film_list(fid: str, req: FilmAction):
    _profile(req.profile_id)
    in_list = films.toggle_list(req.profile_id, _film(fid))
    return {"in_list": in_list, "status": films.status(req.profile_id, fid)}


@app.post("/api/films/{fid}/download")
def film_download(fid: str, req: FilmAction):
    _profile(req.profile_id)
    info = _film(fid)
    source = films.free_source(info)
    if not source:
        raise HTTPException(400, "This film isn't free to download legally. Only public-domain and Creative Commons films are.")
    return films.enqueue_download(info, source, req.profile_id)


@app.post("/api/films/{fid}/delete-file")
def film_delete_file(fid: str):
    if not films.delete_file(fid):
        raise HTTPException(404, "No downloaded file for this film")
    return {"ok": True}


@app.get("/api/films/{fid}/stream")
def film_stream(fid: str):
    path = films.file_path(fid)
    if not path:
        raise HTTPException(404, "Not downloaded")
    return FileResponse(path, media_type="video/mp4")


# ---------- Cloud Drive (NAS) ----------
class DriveAction(BaseModel):
    profile_id: str
    path: str = Field(default="", max_length=1000)
    name: str = Field(default="", max_length=200)
    to: str = Field(default="", max_length=1000)


def _drive(fn, *args):
    try:
        return fn(*args)
    except DriveError as exc:
        raise HTTPException(400, str(exc))
    except OSError as exc:
        raise HTTPException(500, f"Storage error: {exc.strerror or exc}")


@app.get("/api/drive")
def drive_list(profile_id: str, path: str = ""):
    return {**_drive(drive.listing, _profile(profile_id), path), "remote": drive.remote()}


@app.get("/api/drive/recent")
def drive_recent(profile_id: str):
    return _drive(drive.recent, _profile(profile_id))


@app.get("/api/drive/file")
def drive_file(profile_id: str, path: str, download: bool = False):
    target = _drive(drive.resolve, _profile(profile_id), path)
    if not target.is_file():
        raise HTTPException(404, "File not found")
    # Range requests work, so videos and songs stream and seek.
    return FileResponse(target, filename=target.name, content_disposition_type="attachment" if download else "inline")


@app.put("/api/drive/upload")
async def drive_upload(request: Request, profile_id: str, path: str, name: str):
    prof = _profile(profile_id)
    size = int(request.headers.get("content-length") or 0)
    dest = _drive(drive.upload_target, prof, path, name, size)
    part = dest.with_name(f".{dest.name}.part")
    try:
        with open(part, "wb") as f:
            async for chunk in request.stream():
                f.write(chunk)
        part.rename(dest)
    except BaseException:
        part.unlink(missing_ok=True)
        raise
    event = game.record(profile_id, "upload", None, dest.name, {})
    return {"entry": drive._entry(dest), "event": event}


@app.post("/api/drive/folder")
def drive_folder(req: DriveAction):
    return _drive(drive.mkdir, _profile(req.profile_id), req.path, req.name)


@app.post("/api/drive/rename")
def drive_rename(req: DriveAction):
    return _drive(drive.rename, _profile(req.profile_id), req.path, req.name)


@app.post("/api/drive/move")
def drive_move(req: DriveAction):
    return _drive(drive.move, _profile(req.profile_id), req.path, req.to)


@app.post("/api/drive/delete")
def drive_delete(req: DriveAction):
    _drive(drive.delete, _profile(req.profile_id), req.path)
    return {"ok": True}


@app.post("/api/drive/link")
def drive_link(req: DriveAction):
    return _drive(drive.link, _profile(req.profile_id), req.path)


@app.get("/s/{token}")
def shared_link(token: str):
    """Public download for a share link (no profile needed; the link expires)."""
    path = drive.shared_file(token)
    if not path:
        return HTMLResponse("<h1>This link has expired or doesn't exist.</h1>", status_code=404)
    return FileResponse(path, filename=path.name, content_disposition_type="attachment")


# ---------- Music (Deezer catalog, YouTube playback) ----------
class TrackIn(BaseModel):
    id: str = Field(pattern=r"^dz\d{1,15}$")
    title: str = Field(max_length=300)
    artist: str = Field(max_length=300)
    artist_id: int | None = None
    album: str | None = Field(default=None, max_length=300)
    poster: str | None = Field(default=None, max_length=500, pattern=r"^https://[a-z0-9.-]+\.dzcdn\.net/[^\s\"'<>]*$")
    duration: int | None = Field(default=None, ge=0, le=36000)


class TrackAction(BaseModel):
    profile_id: str
    track: TrackIn
    rating: int = Field(default=0, ge=-1, le=1)


def _deezer(fn, *args):
    try:
        return fn(*args)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except Exception as exc:
        raise HTTPException(502, f"Music catalog unavailable: {exc}")


@app.get("/api/music/home")
def music_home(profile_id: str):
    _profile(profile_id)
    return {"rows": music.home(profile_id, library.albums()), "full_songs": music.full_songs}


def _resolve_songs(songs: list[dict], skip: set[str]) -> list[dict]:
    with ThreadPoolExecutor(max_workers=6) as pool:
        found = list(pool.map(lambda s: music.find(s["artist"], s["title"]), songs))
    out = []
    for song, t in zip(songs, found):
        if t and t["id"] not in skip:
            skip.add(t["id"])
            out.append({**t, "reason": song["reason"]})
    return out


@app.get("/api/music/picks")
async def music_picks(profile_id: str, refresh: bool = False):
    prof = _profile(profile_id)
    today = date.today().isoformat()
    cached = db.one("SELECT payload FROM ai_cache WHERE profile_id=? AND day=? AND kind='music'", (profile_id, today))
    if cached and not _claude_refresh(refresh):
        return json.loads(cached["payload"])
    history, liked, disliked = music.history(profile_id, 60), music.liked(profile_id), music.disliked(profile_id)
    tops = [a["artist"] for a in music.top_artists(profile_id, 6)]
    skip = {t["id"] for t in history} | {t["id"] for t in disliked}
    data = None if _guest() else await ai.music_picks(prof, history, liked, disliked, tops)
    songs = await run_in_threadpool(_resolve_songs, data["songs"], skip) if data else []
    if songs:
        result = {"source": "claude", "headline": data["headline"], "tracks": songs}
    else:
        chart = await run_in_threadpool(_deezer, music.chart)
        result = {"source": "offline", "headline": "Top charts right now",
                  "tracks": [{**t, "reason": "One of the most played songs right now."} for t in chart[:20] if t["id"] not in skip],
                  "error": ai.last_error if ai.status["enabled"] else None}
    with db.write() as conn:
        conn.execute("INSERT OR REPLACE INTO ai_cache(profile_id, day, kind, payload) VALUES (?,?,?,?)",
                     (profile_id, today, "music", json.dumps(result)))
    return result


@app.get("/api/music/search")
def music_search(q: str):
    return _deezer(music.search, q)


@app.get("/api/music/artist/{aid}")
def music_artist(aid: int):
    return _deezer(music.artist, aid)


@app.get("/api/music/radio")
def music_radio(profile_id: str, seed: str, exclude: str = ""):
    _profile(profile_id)
    if not (seed.startswith("ar") and seed[2:].isdigit()) and not seed.startswith("dz"):
        raise HTTPException(400, "seed must be a track (dz…) or artist (ar…) id")
    return _deezer(music.radio, profile_id, seed, set(exclude.split(",")[-300:]))


@app.get("/api/music/source/{tid}")
def music_source(tid: str, profile_id: str | None = None):
    src = _deezer(music.source, tid)
    if profile_id:
        _profile(profile_id)
        src["rating_given"] = music.rating(profile_id, tid)
    return src


@app.post("/api/music/start")
def music_start(req: TrackAction):
    """The person started music (not the endless queue moving on): XP, quests and the friends feed."""
    _profile(req.profile_id)
    t = req.track
    return {"event": game.record(req.profile_id, "listen", t.id, f"{t.title} · {t.artist}", {"artist": t.artist})}


@app.post("/api/music/played")
def music_played(req: TrackAction):
    _profile(req.profile_id)
    music.played(req.profile_id, req.track.model_dump())
    return {"ok": True}


@app.post("/api/music/rate")
def music_rate(req: TrackAction):
    _profile(req.profile_id)
    music.rate(req.profile_id, req.track.model_dump(), req.rating)
    return {"rating": req.rating}


# ---------- Game Store ----------
class StoreAction(BaseModel):
    profile_id: str | None = None


@app.get("/api/store")
def store_catalog():
    return {"games": store.catalog(), "jobs": store.active_jobs(), "pc_enabled": store.pc_enabled()}


@app.get("/api/store/jobs")
def store_jobs():
    return store.active_jobs()


def _store_entry(game_id: str, req: StoreAction) -> None:
    if game_id not in STORE_BY_ID:
        raise HTTPException(404, f"{game_id} is not in the Store")
    if req.profile_id:
        _profile(req.profile_id)


@app.post("/api/store/{game_id}/install")
def store_install(game_id: str, req: StoreAction):
    _store_entry(game_id, req)
    return store.enqueue(game_id, "install", req.profile_id)


@app.post("/api/store/{game_id}/uninstall")
def store_uninstall(game_id: str, req: StoreAction):
    _store_entry(game_id, req)
    if (launcher.status().get("item") or {}).get("id") == game_id:
        launcher.stop()
    return store.enqueue(game_id, "uninstall", req.profile_id)


@app.get("/api/launcher")
def launcher_status():
    return launcher.status()


@app.post("/api/launcher/stop")
def launcher_stop():
    launcher.stop()
    return launcher.status()


# ---------- smart home ----------
@app.get("/api/home")
def home_state():
    return home.snapshot()


class DeviceChange(BaseModel):
    profile_id: str
    on: bool | None = None
    brightness: int | None = None
    color: str | None = Field(default=None, pattern="^#[0-9a-fA-F]{6}$")
    target: float | None = None
    speed: int | None = None


@app.post("/api/home/devices/{device_id}")
def set_device(device_id: str, change: DeviceChange):
    _profile(change.profile_id)
    dev = home.set_device(device_id, change.model_dump(exclude_none=True, exclude={"profile_id"}))
    if not dev:
        raise HTTPException(404, f"Unknown device {device_id}")
    event = game.record(change.profile_id, "home", device_id, dev["name"], {})
    return {"device": dev, "home": home.snapshot(), "event": event}


class SceneRequest(BaseModel):
    profile_id: str


@app.post("/api/home/scenes/{scene_id}")
def activate_scene(scene_id: str, req: SceneRequest):
    _profile(req.profile_id)
    scene = home.activate_scene(scene_id)
    if not scene:
        raise HTTPException(404, f"Unknown scene {scene_id}")
    event = game.record(req.profile_id, "home", scene_id, scene["name"], {"scene": True})
    return {"scene": scene, "home": home.snapshot(), "event": event}


# ---------- social ----------
class ShareRequest(BaseModel):
    from_profile: str
    to_profile: str
    kind: str = Field(pattern="^(movie|album|game)$")
    item_id: str
    message: str = Field(default="", max_length=200)


@app.post("/api/share")
def share(req: ShareRequest):
    _profile(req.from_profile)
    _profile(req.to_profile, others=True)
    if req.from_profile == req.to_profile:
        raise HTTPException(400, "Cannot share with yourself")
    item = _item(req.kind, req.item_id)
    with db.write() as conn:
        conn.execute("INSERT INTO shares(from_profile, to_profile, kind, item_id, title, message) VALUES (?,?,?,?,?,?)",
                     (req.from_profile, req.to_profile, req.kind, item["id"], item["title"], req.message))
    event = game.record(req.from_profile, "share", item["id"], item["title"], {"to": req.to_profile})
    return {"event": event}


@app.get("/api/profiles/{pid}/inbox")
def inbox(pid: str):
    _profile(pid)
    return db.all("SELECT s.*, p.name AS from_name, p.hue AS from_hue FROM shares s "
                  "JOIN profiles p ON p.id = s.from_profile WHERE s.to_profile=? ORDER BY s.id DESC LIMIT 30", (pid,))


@app.post("/api/profiles/{pid}/inbox/seen")
def inbox_seen(pid: str):
    _profile(pid)
    with db.write() as conn:
        conn.execute("UPDATE shares SET seen=1 WHERE to_profile=?", (pid,))
    return {"ok": True}


# ---------- Claude ----------
@app.get("/api/ai/recommendations")
async def recommendations(profile_id: str, refresh: bool = False):
    prof = _profile(profile_id)
    history = game.activity(profile_id, 40)
    # Store games not installed yet can be recommended too (kind "store").
    shop = [{"id": g["id"], "kind": "store", "title": g["title"], "tags": [g.get("platform"), g.get("genre")],
             "players": g.get("players")} for g in store.catalog() if not g.get("installed")]
    catalog = library.catalog_digest() + shop
    if _guest():  # no paid calls for visitors
        result = offline_recommendations(prof, history, catalog, home.snapshot())
    else:
        result = await ai.recommendations(prof, history, catalog, home.snapshot(), _claude_refresh(refresh))
    if "games" not in result:  # cached before games and scenes were part of For You
        result = {**result, "games": offline_games(prof, history, catalog), "scene": offline_scene(home.snapshot())}
    return {**result, "items": [library.find(p["kind"], p["item_id"]) for p in result["picks"]]}


class AssistantRequest(BaseModel):
    profile_id: str
    message: str = Field(min_length=1, max_length=1000)
    chat: list[dict] = []


@app.post("/api/ai/assistant")
async def assistant(req: AssistantRequest):
    prof = _profile(req.profile_id)
    snapshot = home.snapshot()
    result = await ai.assistant(prof, req.message, game.activity(req.profile_id, 20), req.chat,
                                library.catalog_digest(), snapshot)
    event = game.record(req.profile_id, "ai", None, req.message[:80], {})
    return {**result, "actions": _run_actions(result.get("actions", [])), "home": home.snapshot(), "event": event}


def _run_actions(actions: list[dict]) -> list[dict]:
    done = []
    for action in actions:
        target = action["target_id"]
        if action["type"] == "scene":
            scene = home.activate_scene(target)
            if scene:
                done.append({**action, "label": f"Scene: {scene['name']}"})
        elif action["type"] in ("device_on", "device_off"):
            dev = home.set_device(target, {"on": action["type"] == "device_on"})
            if dev:
                done.append({**action, "label": f"{dev['name']}: {'on' if dev['on'] else 'off'}"})
        elif action["type"] == "play":
            item = next(filter(None, (library.find(k, target) for k in ("movie", "album", "game"))), None)
            if item:
                done.append({**action, "label": f"Play: {item['title']}", "item": item})
    return done


@app.post("/api/ai/chat")
def chat(req: AssistantRequest):
    """The free assistant, streamed as JSON lines: {"delta": text}… then {"done": true, reply, actions, …}.
    Commands act at once (rule-based); anything else is answered by the local model on the Pi."""
    prof = _profile(req.profile_id)
    if not auth.allow(current.get(), "chat"):
        raise HTTPException(429, "Let's take a short break: try again in a minute.")
    catalog = library.catalog_digest()
    command = offline_assistant(prof, req.message, catalog, home.snapshot())
    refused = _guest() and any(a["type"] != "play" for a in command["actions"])
    if refused:
        # Visitors can't switch the house; play suggestions are fine (they open in the browser).
        command = {**command, "actions": [], "reply": "Guests can look around, but the house stays as it is. "
                   "Ask me anything about aPiStation, or say \"play Daft Punk\"."}
    actions = _run_actions(command["actions"])
    songs = None if actions or refused else music_command(req.message, music)
    # Common questions about the console: answered at once and correctly, with a button to the right screen.
    faq = None if actions or songs or refused else faq_answer(req.message)

    def lines():
        reply, source = "", "local"
        if actions or songs or refused:
            source = "command"
            reply = f"On it, {prof['name']}: {songs['said']}." if songs else command["reply"]
            yield json.dumps({"delta": reply}) + "\n"
        elif faq:
            source = "faq"
            reply = faq["reply"]
            yield json.dumps({"delta": reply}) + "\n"
        elif local_ai.ready:
            try:
                for piece in local_ai.stream(prof, req.message, req.chat, catalog, home.snapshot()):
                    reply += piece
                    yield json.dumps({"delta": piece}) + "\n"
            except Exception as exc:
                logging.getLogger("apistation").warning("Local model failed: %s", exc)
                if not reply:
                    source = "offline"
                    reply = "My local brain is busy or restarting. Try again in a minute, or use a command like \"good night\"."
                    yield json.dumps({"delta": reply}) + "\n"
        else:
            source = "offline"
            reply = ("The free local model isn't running yet (scripts/install-local-llm.sh installs it). "
                     "Commands still work: \"play Sintel\", \"play Daft Punk\", \"movie night lights\", \"good night\".")
            yield json.dumps({"delta": reply}) + "\n"
        event = game.record(req.profile_id, "ai", None, req.message[:80], {})
        yield json.dumps({"done": True, "reply": reply.strip(), "source": source, "model": MODEL_NAME if source == "local" else None,
                          "actions": actions or (faq["actions"] if faq else []), "songs": songs, "home": home.snapshot(), "event": event}) + "\n"

    return StreamingResponse(lines(), media_type="application/x-ndjson")


app.mount("/", StaticFiles(directory=settings.console_dir, html=True), name="console")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=settings.host, port=settings.port)
