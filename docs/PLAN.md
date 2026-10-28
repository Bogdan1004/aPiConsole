# aPiStation — Plan de proiect

> Un „cloud personal” pe Raspberry Pi, cu interfață de consolă (stil PlayStation) pe HDMI:
> filme, muzică, gaming, stocare, smart home și recomandări AI (Claude), totul gamificat.

## 1. Viziune

Porneşti Pi-ul, televizorul arată direct animaţia de boot **aPiStation**, apoi ecranul de
alegere a profilului. Navighezi doar cu controlerul (sau tastatura): fiecare film văzut,
album ascultat, joc pornit sau scenă smart-home activată îţi aduce **XP**, urci în nivel,
deblochezi **trofee** şi completezi **misiuni zilnice**. Claude îţi recomandă ce să faci în
seara asta şi poate executa comenzi („pune lumină de film şi porneşte Interstellar”).

## 2. Arhitectură

```
┌──────────────── Pi #1 — "Cloud" (server) ───────────────┐      ┌──────── Pi #2 — "Console" (TV) ────────┐
│  Docker stack                                           │      │  labwc/cage  →  Chromium kiosk          │
│   • Jellyfin   (filme/seriale, SyncPlay)                │      │      └─ console/  (UI-ul aPiStation)    │
│   • Navidrome  (muzică, playlisturi partajate)          │ LAN/ │  aPiStation Hub (rol "console")         │
│   • Home Assistant (smart home)                         │ Tail-│   • lansează VLC / RetroArch / Moonlight │
│   • Samba + SSD (NAS)                                   │ scale│   • proxy către hub-ul server           │
│  aPiStation Hub (rol "server")                          │◄────►│  Controler: Gamepad API                 │
│   • API unificat, profiluri, XP, trofee, misiuni        │      └─────────────────────────────────────────┘
│   • Claude API (cheia stă DOAR aici)                    │
│   • SQLite                                              │
└─────────────────────────────────────────────────────────┘
```

* **Hub** (`hub/`, Python + FastAPI): un singur API pentru toate serviciile. Fiecare serviciu
  are un *adapter* (Jellyfin, Navidrome, Home Assistant, RetroArch, disc). Dacă un serviciu
  nu e configurat, adapterul cade pe **date demo**, aşa că interfaţa merge de la prima rulare.
* **Console** (`console/`, HTML/CSS/JS fără build step): rulează în Chromium kiosk. Fără
  framework şi fără Node — rapid pe Pi 4, uşor de livrat offline.
* **Kiosk** (`kiosk/`): servicii systemd + autostart, astfel încât Pi-ul bootează direct în UI.
* **Un singur cod, două roluri**: `APISTATION_ROLE=all` (un singur Pi, dezvoltare),
  `server` sau `console` (setup-ul cu 2 Pi-uri).

### De ce aşa
| Decizie | Motiv |
|---|---|
| UI web în Chromium kiosk | cel mai rapid de construit, animaţii fluide, Gamepad API nativ |
| Vanilla JS, fără build | Pi-ul nu are nevoie de Node; se editează şi se rulează imediat |
| FastAPI + SQLite | uşor, rulează bine pe ARM, fără server de bază de date |
| Cheia Claude doar pe hub | consola nu ţine secrete; costurile se controlează central (cache zilnic) |
| Adaptere cu fallback demo | dezvoltăm UI-ul înainte să avem Jellyfin/HA instalate |

## 3. Hardware

* **Acum:** Raspberry Pi 4 Model B, 4 GB RAM, Debian 13 (trixie), card 32 GB.
* **Ţintă:** 2 plăci (ideal Pi 5 pentru server), SSD extern pe USB 3 pentru NAS, controler
  Bluetooth/USB (Xbox / 8BitDo / DualSense).
* **Limitări de reţinut:**
  * Pi-ul nu face transcodare video bine → fişierele trebuie să meargă prin *direct play*
    (H.264 / HEVC); VLC/Jellyfin le redau fluid.
  * Gaming = emulare retro (NES → PS1/N64, parţial PSP/Dreamcast) prin RetroArch; jocurile
    moderne doar prin streaming de pe PC (Moonlight + Sunshine).
  * 4 GB RAM pe un singur Pi e puţin pentru tot stack-ul → împărţirea pe 2 Pi-uri.

## 4. Gamificare

| Element | Cum funcţionează |
|---|---|
| **XP & niveluri** | fiecare acţiune dă XP (film +40, album +25, joc +30, scenă smart home +10, întrebare AI +15, share +20); curba de nivel creşte progresiv |
| **Titluri** | Rookie → Explorer → Curator → Cloud Captain → Pi Legend |
| **Trofee** | bronz / argint / aur / platină, cu animaţie „Trophy unlocked” şi sunet |
| **Misiuni zilnice** | 3 misiuni generate zilnic (ex. „Ascultă 2 albume”, „Joacă 1 joc retro”) cu bonus XP |
| **Streak** | zile consecutive de folosire, cu flacără în bara de sus |
| **Social** | al doilea profil vede ce faci, primeşte share-uri, invitaţii co-op (Netplay) şi SyncPlay |

## 5. Funcţionalitatea AI (Claude)

* **Recomandări** (`/api/ai/recommendations`): hub-ul trimite istoricul profilului şi ce există
  în bibliotecă; Claude răspunde cu JSON structurat (titlu, tip, motiv, „vibe”). Rezultatul se
  pune în cache per profil pe zi → câteva apeluri pe zi, cost minim.
* **Asistent** (`/api/ai/assistant`): întrebări libere sau comenzi; răspunsul conţine text +
  o listă de **acţiuni** (porneşte media, activează scenă, lansează joc) pe care hub-ul le
  execută.
* **Fără cheie API** → mod „offline oracle”: recomandări euristice, ca demo-ul să meargă oricând.
* Model: `claude-opus-5-5`, structured outputs, prompt caching pe promptul de sistem.

## 6. Etape (roadmap)

### Faza 0 — Fundaţia ✅
- [x] Plan + arhitectură
- [x] Hub: API unificat, profiluri, XP/trofee/misiuni, adaptere cu date demo
- [x] Consolă: boot animat, selectare profil, meniu principal tip PS, navigare controler
- [x] Ecrane: Movies, Music (synth chiptune live), Games (+ π Snake integrat), Smart Home, Cloud Drive, Claude, Friends, Trophies, Settings
- [x] Claude: recomandări + asistent cu acţiuni, cu fallback offline
- [x] Social: share între profiluri, inbox, feed de activitate, comparare trofee
- [x] Kiosk: scripturi de boot direct în UI pe HDMI (`kiosk/install.sh`)
- [ ] Test pe TV cu controler fizic + cheie Claude reală

### Faza 1 — „Cloud”-ul real (Pi #1)
- Docker + docker compose; Jellyfin, Navidrome, Samba pe SSD, Tailscale
- Home Assistant în container, integrare prin token
- Adaptere reale în hub (env vars în `hub/.env`)

### Faza 2 — Gaming *(începută)*
- [x] RetroArch + cores din Debian (NES, SNES, GB/GBC, GBA, Mega Drive), bibliotecă de ROM-uri în `~/roms`
- [x] Jocuri homebrew gratuite descărcate automat; lansare din consolă, Start + Select revine în UI
- [x] Game Store: 33 de jocuri gratuite (homebrew + open-source), poze oficiale, descărcare/ștergere cu progres, XP și trofeu
- [x] Box art automat pentru ROM-urile proprii (libretro-thumbnails)
- [ ] PS1 / N64 (cores care nu sunt în Debian: pcsx_rearmed, mupen64plus)
- [ ] Moonlight pentru streaming de pe PC

### Faza 2b — Movies în stil Netflix *(gata)*
- [x] Recomandări Claude din toate filmele, căutare, My List, Watched (păstrat după ștergere), trailere
- [x] Descărcări legale (CC + domeniu public UE) de pe Internet Archive; redare pe TV (VLC) și în browser
- [x] Pe Home: tab-uri Top movies / Watch history / On your Pi; filmul ales se deschide direct în Movies
- [ ] „Unde se poate vedea legal” (Netflix, HBO Max etc.) cu o cheie TMDB gratuită

### Faza 2c — Music în stil YouTube Music *(gata)*
- [x] Căutare în tot catalogul Deezer (fără cheie), topuri, pagini de artist, istoric, like/dislike
- [x] Claude's mix (15 piese din toată muzica) și radio fără sfârșit cu piese asemănătoare
- [x] Piese întregi prin playerul oficial YouTube (cheie gratuită), preview 30 s fără cheie; picture-in-picture
- [ ] Test pe TV cu cheia YouTube; volum din Settings aplicat live

### Faza 3 — Două console, doi utilizatori *(în mare parte gata)*
- [ ] Al doilea Pi în rol `console`, ambele legate la hub-ul server
- [x] Share de muzică/filme între profiluri, inbox, prezenţă „online” în timp real (WebSocket)
- [x] Watch together / Listen together sincronizate și RetroArch Netplay („Play online”)
- [x] Telefonul ca controler (QR, gamepad, scris pe TV)
- [x] aPi Wrapped: statistici, persona de la Claude, leaderboard, provocări săptămânale
- [x] Monitor: istoric CPU/temperatură/memorie/rețea, jurnal de securitate, alerte

### Faza 4 — AI avansat
- Asistent vocal (microfon USB + speech-to-text), comenzi smart home în limbaj natural
- Misiuni zilnice personalizate de Claude

### Faza 5 — Finisare & prezentare
- Teme vizuale, mod performanţă, setări
- Demo live pentru profesor, documentaţie, diagrame

## 7. Structura repo-ului

```
aPiConsole/
├── docs/PLAN.md            ← acest document
├── hub/                    ← backend FastAPI
│   ├── app/
│   │   ├── main.py         ← rute API + servire consolă
│   │   ├── config.py       ← setări din .env
│   │   ├── db.py           ← SQLite
│   │   ├── gamification.py ← XP, niveluri, trofee, misiuni
│   │   ├── ai.py           ← Claude (recomandări + asistent)
│   │   ├── demo_data.py    ← bibliotecă demo
│   │   └── services/       ← adaptere: media, music, games, home, system, launcher
│   └── requirements.txt
├── console/                ← interfaţa TV (static)
│   ├── index.html
│   ├── css/
│   └── js/
├── kiosk/                  ← systemd + autostart pentru boot în UI
└── scripts/                ← dev / instalare
```

## 8. Cum demonstrăm proiectul

1. Pornim Pi-ul → animaţie boot → selectăm profilul „Bogdan”.
2. Pornim un film demo → primim XP, se completează o misiune, apare un trofeu.
3. Activăm scena „Movie Night” din Smart Home.
4. Cerem lui Claude „ce să ascult acum?” → recomandări din biblioteca proprie.
5. Comutăm pe al doilea profil → vedem melodia partajată de primul utilizator.
