"""Instant answers for the common questions about aPiStation, in English and Romanian.

The local model is slow on a Pi 4 (about a word a second) and sometimes gets details wrong, so the questions people
ask most are matched by keywords first and answered at once, correctly, with a button to the right screen. Anything
else still goes to the model.
"""

import re

from .ai import _norm

# Words that tell the two languages apart (after diacritics are removed).
RO_WORDS = {"ce", "cum", "unde", "pot", "poti", "este", "sunt", "si", "sa", "nu", "de", "la", "cu", "pe", "mi",
            "imi", "asta", "aceasta", "vreau", "cand", "care", "fac", "ma", "consola", "jocuri", "filme", "muzica",
            "melodie", "melodia", "trofee", "fisiere", "poze", "lumini", "cine", "esti", "sau", "din", "pentru"}
EN_WORDS = {"what", "how", "where", "can", "is", "are", "the", "do", "to", "my", "of", "and", "you", "with", "does",
            "who", "why", "which", "games", "movies", "music", "song", "files", "photos", "lights", "earn", "get"}

# Each entry: keywords (normalized, a phrase may have spaces) with weights, answers, and an optional screen to open.
FAQ = [
    {
        "id": "overview",
        "keys": {"what can": 2, "ce poate": 2, "ce pot face": 3, "what is apistation": 3, "ce este apistation": 3,
                 "ce e apistation": 3, "apistation": 1, "consola": 1, "console": 1, "features": 2, "functii": 2},
        "en": "aPiStation is a home console and personal cloud on this Raspberry Pi: Netflix-style movies, music from "
              "any artist with an endless radio, retro and Linux games plus a free game Store, smart home scenes, a "
              "Cloud Drive for your files, and Claude's picks for all of them. Everything you do earns XP, trophies "
              "and daily quests.",
        "ro": "aPiStation e o consolă și un cloud personal pe acest Raspberry Pi: filme în stil Netflix, muzică de la "
              "orice artist cu radio fără sfârșit, jocuri retro și Linux plus un Store gratuit, scene pentru casa "
              "inteligentă, un Cloud Drive pentru fișiere și recomandări de la Claude pentru toate. Orice faci îți "
              "aduce XP, trofee și misiuni zilnice.",
    },
    {
        "id": "music",
        "keys": {"music": 2, "song": 2, "songs": 2, "listen": 2, "artist": 1, "playlist": 2, "radio": 1,
                 "muzica": 2, "melodie": 2, "melodia": 2, "melodii": 2, "piesa": 2, "piese": 2, "ascult": 2,
                 "asculta": 2, "youtube": 1, "spotify": 1},
        "open": ("music", "Open Music"),
        "en": "Open Music and search any song or artist, or just tell me \"play\" and a name, like \"play Queen\". "
              "When the list ends, the endless radio keeps adding similar songs. Full songs play through YouTube once "
              "a YouTube key is set; otherwise you hear 30-second previews.",
        "ro": "Deschide Music și caută orice piesă sau artist, sau spune-mi direct „pune” și un nume, de exemplu "
              "„pune-mi Queen”. Când se termină lista, radioul fără sfârșit adaugă piese asemănătoare. Piesele întregi "
              "merg prin YouTube când e setată o cheie YouTube; altfel auzi preview-uri de 30 de secunde.",
    },
    {
        "id": "movies",
        "keys": {"movie": 2, "movies": 2, "film": 2, "filme": 2, "filmul": 2, "watch": 1, "vad": 1, "uit": 1,
                 "netflix": 2, "trailer": 2, "download": 1, "descarc": 1, "my list": 2},
        "open": ("movies", "Open Movies"),
        "en": "Open Movies: Claude recommends films from everything ever released, based on what you watched and rated. "
              "You can search any film, watch its trailer and keep My List. Only legally free films (public-domain "
              "classics and Blender's open movies) can be downloaded to the Pi and played on the TV or in a browser.",
        "ro": "Deschide Movies: Claude îți recomandă filme din tot ce s-a lansat vreodată, după ce ai văzut și notat. "
              "Poți căuta orice film, vedea trailerul și ține o listă My List. Doar filmele gratuite legal (clasice în "
              "domeniul public și filmele Blender) se pot descărca pe Pi și rula pe TV sau în browser.",
    },
    {
        "id": "games",
        "keys": {"game": 2, "games": 2, "joc": 2, "jocuri": 2, "jocul": 2, "joaca": 1, "retro": 2, "emulator": 2,
                 "retroarch": 2, "nes": 1, "snake": 1},
        "open": ("games", "Open Games"),
        "en": "Open Games: retro games run full screen on the TV with RetroArch, or right in a laptop browser, and "
              "there are native Linux games and Pi Snake. To leave a game on the TV, hold Start and Select together "
              "(or press Esc). More free games are in the Store.",
        "ro": "Deschide Games: jocurile retro rulează pe tot ecranul pe TV cu RetroArch sau direct în browser pe laptop, "
              "iar pe lângă ele sunt jocuri Linux și Pi Snake. Ca să ieși dintr-un joc pe TV, ține apăsat Start și "
              "Select împreună (sau Esc). Mai multe jocuri gratuite găsești în Store.",
    },
    {
        "id": "store",
        "keys": {"store": 2, "install": 2, "instalez": 2, "instala": 2, "download games": 3, "descarc jocuri": 3,
                 "uninstall": 2, "sterg jocul": 3, "magazin": 2},
        "open": ("store", "Open the Store"),
        "en": "The Game Store has only free and legal games: homebrew made for retro consoles and open-source PC games. "
              "Pick one and it downloads in the background; you can delete it whenever you want. Each download earns XP "
              "and counts toward the Game Collector trophy.",
        "ro": "Game Store are doar jocuri gratuite și legale: homebrew pentru console retro și jocuri PC open-source. "
              "Alegi unul și se descarcă în fundal; îl poți șterge oricând. Fiecare descărcare îți dă XP și contează "
              "pentru trofeul Game Collector.",
    },
    {
        "id": "trophies",
        "keys": {"trophy": 2, "trophies": 2, "trofeu": 2, "trofee": 2, "xp": 2, "level": 2, "levels": 2, "nivel": 2,
                 "niveluri": 2, "quest": 2, "quests": 2, "misiuni": 2, "misiune": 2, "streak": 2, "platinum": 2,
                 "puncte": 1, "points": 1},
        "open": ("trophies", "View trophies"),
        "en": "You earn XP for watching, listening, playing, using the smart home, asking me things, sharing and "
              "uploading. XP raises your level, three daily quests give bonus XP, and signing in every day keeps your "
              "streak. There are bronze, silver and gold trophies, and Platinum once you have all the others.",
        "ro": "Primești XP când te uiți la filme, asculți muzică, joci, folosești casa inteligentă, mă întrebi ceva, "
              "dai share sau urci fișiere. XP-ul îți crește nivelul, cele trei misiuni zilnice dau XP în plus, iar dacă "
              "intri în fiecare zi îți păstrezi streak-ul. Trofeele sunt de bronz, argint și aur, iar Platinum vine "
              "când le ai pe toate celelalte.",
    },
    {
        "id": "drive",
        "keys": {"file": 2, "files": 2, "fisier": 2, "fisiere": 2, "upload": 2, "urc": 2, "incarc": 2, "photo": 2,
                 "photos": 2, "poze": 2, "poza": 2, "drive": 2, "cloud": 2, "nas": 2, "storage": 2, "stocare": 2,
                 "folder": 1, "backup": 2},
        "open": ("drive", "Open Cloud Drive"),
        "en": "Cloud Drive is your own cloud on the Pi: a Shared folder for everyone and a private folder for you. "
              "From a laptop or phone at apiconsole.local:8420 you can upload (or drag files in), preview photos, "
              "videos and music, download, and share any file with a link that lasts 7 days. Deleted files wait 30 "
              "days in the trash.",
        "ro": "Cloud Drive e cloud-ul tău pe Pi: un folder Shared pentru toți și unul privat pentru tine. De pe laptop "
              "sau telefon, la apiconsole.local:8420, poți urca fișiere (și prin drag and drop), vedea poze, video și "
              "muzică, descărca și da share cu un link valabil 7 zile. Fișierele șterse stau 30 de zile în coș.",
    },
    {
        "id": "smarthome",
        "keys": {"light": 2, "lights": 2, "lumina": 2, "lumini": 2, "smart home": 3, "casa": 1, "house": 1,
                 "scene": 2, "scena": 2, "scenes": 2, "heating": 2, "caldura": 2, "lock": 1, "bec": 2, "becuri": 2},
        "open": ("smarthome", "Open Smart Home"),
        "en": "Smart Home controls lights, scenes, heating and locks. Pick a scene there, or just tell me \"movie night "
              "lights\", \"party\", \"good night\", \"morning\" or \"focus\" and I switch the house at once.",
        "ro": "Smart Home controlează luminile, scenele, căldura și încuietorile. Alege o scenă de acolo sau spune-mi "
              "direct „movie night lights”, „party”, „noapte bună”, „dimineața” sau „focus” și schimb casa imediat.",
    },
    {
        "id": "friends",
        "keys": {"share": 2, "friend": 2, "friends": 2, "prieten": 2, "prietenul": 2, "prieteni": 2, "trimit": 2,
                 "inbox": 2, "together": 2, "impreuna": 2, "multiplayer": 2},
        "open": ("friends", "Open Friends"),
        "en": "Press X on a movie, album or game to share it with the other player; it lands in their inbox on Friends, "
              "where you also see what they're up to. Games marked for two players can be played together.",
        "ro": "Apasă X pe un film, album sau joc ca să-l trimiți celuilalt jucător; ajunge în inbox-ul lui din Friends, "
              "unde vezi și ce face. Jocurile pentru doi jucători le puteți juca împreună.",
    },
    {
        "id": "controls",
        "keys": {"controls": 2, "controller": 2, "gamepad": 2, "buttons": 2, "button": 1, "keyboard": 2, "butoane": 2,
                 "controlere": 2, "controler": 2, "taste": 2, "tastatura": 2, "navighez": 2, "navigate": 2},
        "en": "Arrows or the D-pad move, A or Enter selects, B or Esc goes back, X shares or likes, Y opens For You "
              "and me, Start (or M) opens the quick menu, and Select (V) pauses music while LB/RB (Q/E) skip songs.",
        "ro": "Săgețile sau D-pad-ul te mută, A sau Enter selectează, B sau Esc te duce înapoi, X dă share sau like, "
              "Y deschide For You și chat-ul cu mine, Start (sau M) deschide meniul rapid, iar Select (V) pune muzica "
              "pe pauză și LB/RB (Q/E) schimbă piesele.",
    },
    {
        "id": "security",
        "keys": {"pin": 3, "password": 2, "parola": 2, "guest": 2, "oaspete": 2, "invitat": 2, "sign out": 3,
                 "logout": 2, "deconectez": 2, "securitate": 2, "security": 2, "safe": 1, "sigur": 1, "account": 1,
                 "profile": 1, "profil": 1},
        "open": ("settings", "Open Settings"),
        "en": "Bogdan and Alex sign in with a 4-digit PIN, and this device can remember it for 90 days. Guest needs no "
              "PIN but is read-only: it can look around, play in the browser and chat, but can't change anything. "
              "You can change your PIN or sign out in Settings.",
        "ro": "Bogdan și Alex intră cu un PIN din 4 cifre, iar dispozitivul îl poate ține minte 90 de zile. Guest nu "
              "are PIN, dar poate doar să se uite: navighează, joacă în browser și vorbește cu mine, fără să schimbe "
              "nimic. PIN-ul îl schimbi sau ieși din cont din Settings.",
    },
    {
        "id": "assistant",
        "keys": {"who are you": 3, "cine esti": 3, "are you claude": 3, "esti claude": 3, "chatgpt": 2, "ai": 1,
                 "model": 1, "assistant": 1, "asistent": 1, "asistentul": 1},
        "en": "I'm the aPi Assistant, a small free model (Qwen2.5 1.5B) running right here on the Pi, so chatting costs "
              "nothing and stays private. I answer common questions instantly and think a bit slower about the rest. "
              "Claude, in the cloud, only picks your films, music and games once a day.",
        "ro": "Sunt aPi Assistant, un model mic și gratuit (Qwen2.5 1.5B) care rulează chiar pe acest Pi, așa că "
              "discuția nu costă nimic și rămâne privată. La întrebările obișnuite răspund imediat, la restul mă "
              "gândesc puțin mai mult. Claude, din cloud, îți alege doar filmele, muzica și jocurile, o dată pe zi.",
    },
    {
        "id": "recommendations",
        "keys": {"recommend": 2, "recommendations": 2, "recomanzi": 2, "recomandari": 2, "recomandare": 2,
                 "picks": 2, "for you": 3, "suggest": 2, "sugestii": 2},
        "open": ("ai", None),
        "en": "For You has picks for everything: tonight's lineup, films, Claude's music mix, games from your library "
              "and the Store, and the right scene for the house, each with the reason. Claude makes them once a day "
              "from what you watched, played and liked; press Y there for new ones.",
        "ro": "For You are recomandări pentru tot: lineup-ul de diseară, filme, mix-ul de muzică de la Claude, jocuri "
              "din biblioteca ta și din Store și scena potrivită pentru casă, fiecare cu motivul ei. Claude le face o "
              "dată pe zi după ce ai văzut, jucat și apreciat; apasă Y acolo pentru altele noi.",
    },
    {
        "id": "remote",
        "keys": {"outside": 2, "remote": 2, "anywhere": 2, "afara": 2, "oriunde": 2, "online": 2, "internet": 1,
                 "tailscale": 3, "phone": 1, "telefon": 1, "laptop": 1},
        "en": "At home, open apiconsole.local:8420 in any browser. From outside, the safe way is Tailscale, a free "
              "private network between the Pi and your own devices, with no ports opened on the router. For a public "
              "demo, visitors use the read-only Guest profile.",
        "ro": "Acasă, deschide apiconsole.local:8420 în orice browser. Din afara casei, varianta sigură e Tailscale, o "
              "rețea privată gratuită între Pi și dispozitivele tale, fără porturi deschise în router. Pentru un demo "
              "public, vizitatorii folosesc profilul Guest, care doar se uită.",
    },
    {
        "id": "hardware",
        "keys": {"raspberry": 2, "hardware": 2, "specs": 2, "how does it work": 3, "cum functioneaza": 3,
                 "built": 1, "facut": 1, "arhitectura": 2, "architecture": 2, "python": 2, "fastapi": 2},
        "en": "Everything runs on a Raspberry Pi 4 with 4 GB of RAM: a Python (FastAPI) hub serves the API and this "
              "interface, Chromium shows it full screen on the TV, RetroArch runs the games, and a SQLite database "
              "keeps profiles, XP and history. Claude makes the picks and I run locally with llama.cpp.",
        "ro": "Totul rulează pe un Raspberry Pi 4 cu 4 GB RAM: un hub în Python (FastAPI) servește API-ul și această "
              "interfață, Chromium o afișează pe tot ecranul pe TV, RetroArch rulează jocurile, iar o bază SQLite "
              "ține profilurile, XP-ul și istoricul. Claude face recomandările, iar eu rulez local cu llama.cpp.",
    },
]

SCREEN_LABEL = {"ai": ("For You", "Open For You")}
THRESHOLD = 2


def language(message: str) -> str:
    """'ro' or 'en', from diacritics and common words."""
    if re.search(r"[ăâîșşțţ]", message.lower()):
        return "ro"
    words = set(re.findall(r"[a-z]+", _norm(message)))
    return "ro" if len(words & RO_WORDS) > len(words & EN_WORDS) else "en"


def answer(message: str) -> dict | None:
    """The FAQ answer for a message, or None when no entry clearly matches."""
    text = f" {' '.join(re.findall(r'[a-z0-9]+', _norm(message)))} "
    scored = []
    for entry in FAQ:
        score = sum(weight for key, weight in entry["keys"].items() if f" {key} " in text)
        scored.append((score, entry))
    scored.sort(key=lambda s: s[0], reverse=True)
    best_score, best = scored[0]
    if best_score < THRESHOLD or (len(scored) > 1 and scored[1][0] == best_score and best_score < 4):
        return None  # nothing matched, or two topics tie on a weak match: let the model answer
    lang = language(message)
    actions = []
    if best.get("open"):
        screen, label = best["open"]
        actions.append({"type": "open", "screen": screen, "label": label or SCREEN_LABEL[screen][1]})
    return {"id": best["id"], "lang": lang, "reply": best[lang], "actions": actions}
