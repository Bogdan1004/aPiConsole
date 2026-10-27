"""Demo library used when Jellyfin / Navidrome / Home Assistant are not configured.

Movies are Blender open movies and public-domain classics, so the same entries
can later be backed by real, legally playable files in APISTATION_MEDIA.
Albums are fictional: the console synthesizes a chiptune loop for each one.
"""

MOVIES = [
    {
        "id": "big-buck-bunny", "title": "Big Buck Bunny", "year": 2008, "minutes": 10,
        "genres": ["Animation", "Comedy"], "rating": 7.4, "art": "sunset",
        "palette": ["#f59e0b", "#84cc16"], "file": "big_buck_bunny.mp4",
        "synopsis": "A gentle giant rabbit has had enough of three rodents bullying the forest, and plans a very creative revenge.",
    },
    {
        "id": "sintel", "title": "Sintel", "year": 2010, "minutes": 15,
        "genres": ["Fantasy", "Adventure"], "rating": 7.5, "art": "orbit",
        "palette": ["#ef4444", "#7c3aed"], "file": "sintel.mp4",
        "synopsis": "A lone warrior crosses snowy mountains and ruined cities looking for the baby dragon she once raised.",
    },
    {
        "id": "tears-of-steel", "title": "Tears of Steel", "year": 2012, "minutes": 12,
        "genres": ["Sci-Fi", "Action"], "rating": 6.4, "art": "grid",
        "palette": ["#0ea5e9", "#1e293b"], "file": "tears_of_steel.mp4",
        "synopsis": "In a future Amsterdam, a group of scientists stages a desperate experiment to stop an army of robots.",
    },
    {
        "id": "elephants-dream", "title": "Elephants Dream", "year": 2006, "minutes": 11,
        "genres": ["Sci-Fi", "Surreal"], "rating": 6.5, "art": "rings",
        "palette": ["#14b8a6", "#78350f"], "file": "elephants_dream.mp4",
        "synopsis": "Two strangers wander an endless mechanical world that seems to rebuild itself around them.",
    },
    {
        "id": "cosmos-laundromat", "title": "Cosmos Laundromat", "year": 2015, "minutes": 12,
        "genres": ["Comedy", "Fantasy"], "rating": 7.2, "art": "waves",
        "palette": ["#ec4899", "#0f766e"], "file": "cosmos_laundromat.mp4",
        "synopsis": "A sheep tired of his island meets a mysterious salesman who offers him every life he could want.",
    },
    {
        "id": "spring", "title": "Spring", "year": 2019, "minutes": 8,
        "genres": ["Fantasy", "Animation"], "rating": 7.3, "art": "mountains",
        "palette": ["#22c55e", "#312e81"], "file": "spring.mp4",
        "synopsis": "A shepherd girl and her dog face ancient spirits to bring the cycle of life back to their valley.",
    },
    {
        "id": "sprite-fright", "title": "Sprite Fright", "year": 2021, "minutes": 10,
        "genres": ["Horror", "Comedy"], "rating": 7.0, "art": "mountains",
        "palette": ["#a3e635", "#4c1d95"], "file": "sprite_fright.mp4",
        "synopsis": "Teenagers on a forest trip discover that the cute mushroom sprites are not fans of littering.",
    },
    {
        "id": "agent-327", "title": "Agent 327: Operation Barbershop", "year": 2017, "minutes": 4,
        "genres": ["Action", "Comedy"], "rating": 7.6, "art": "grid",
        "palette": ["#f97316", "#1e3a8a"], "file": "agent_327.mp4",
        "synopsis": "A seasoned secret agent goes undercover in a barbershop and finds far more than a haircut.",
    },
    {
        "id": "charge", "title": "Charge", "year": 2022, "minutes": 4,
        "genres": ["Action", "Sci-Fi"], "rating": 6.8, "art": "rings",
        "palette": ["#facc15", "#7f1d1d"], "file": "charge.mp4",
        "synopsis": "In a world short of energy, an old woman takes on a robot guarding the last power source.",
    },
    {
        "id": "nosferatu", "title": "Nosferatu", "year": 1922, "minutes": 94,
        "genres": ["Horror", "Classic"], "rating": 7.8, "art": "moon",
        "palette": ["#94a3b8", "#0f172a"], "file": "nosferatu.mp4",
        "synopsis": "The silent-era original: an estate agent travels to the castle of the strange Count Orlok.",
    },
    {
        "id": "the-general", "title": "The General", "year": 1926, "minutes": 79,
        "genres": ["Comedy", "Classic"], "rating": 8.1, "art": "sunset",
        "palette": ["#d97706", "#292524"], "file": "the_general.mp4",
        "synopsis": "Buster Keaton chases a stolen locomotive across enemy lines in one of cinema's great stunt films.",
    },
    {
        "id": "trip-to-the-moon", "title": "A Trip to the Moon", "year": 1902, "minutes": 13,
        "genres": ["Sci-Fi", "Classic"], "rating": 8.2, "art": "moon",
        "palette": ["#e2e8f0", "#1e1b4b"], "file": "trip_to_the_moon.mp4",
        "synopsis": "Georges Méliès sends a team of astronomers to the Moon by cannon in the first great sci-fi film.",
    },
]

ALBUMS = [
    {
        "id": "pixel-hearts", "title": "Pixel Hearts", "artist": "Neon Arcade", "year": 2024,
        "genre": "Chiptune", "mood": "energetic", "bpm": 138, "scale": "major", "root": 60,
        "art": "grid", "palette": ["#f472b6", "#6d28d9"],
        "tracks": ["Insert Coin", "Heart Container", "Boss Rush", "High Score Kiss"],
    },
    {
        "id": "late-night-pi", "title": "Late Night π", "artist": "Lo-Fi Raspberry", "year": 2025,
        "genre": "Lo-Fi", "mood": "chill", "bpm": 78, "scale": "dorian", "root": 57,
        "art": "moon", "palette": ["#c084fc", "#1e293b"],
        "tracks": ["3.14 AM", "Rainy GPIO", "Soft Boot", "Cache Me Outside"],
    },
    {
        "id": "grid-runner", "title": "Grid Runner", "artist": "Synthwave Drive", "year": 2023,
        "genre": "Synthwave", "mood": "nostalgic", "bpm": 110, "scale": "minor", "root": 55,
        "art": "sunset", "palette": ["#fb923c", "#be185d"],
        "tracks": ["Neon Highway", "Chrome Sunset", "Overdrive", "Last Arcade"],
    },
    {
        "id": "stardust", "title": "Stardust", "artist": "Chill Orbit", "year": 2025,
        "genre": "Ambient", "mood": "dreamy", "bpm": 64, "scale": "lydian", "root": 62,
        "art": "orbit", "palette": ["#38bdf8", "#312e81"],
        "tracks": ["Low Orbit", "Nebula Nap", "Solar Wind", "Gravity Well"],
    },
    {
        "id": "eight-bit-quest", "title": "8-Bit Quest", "artist": "Retro Dungeon", "year": 2022,
        "genre": "Chiptune", "mood": "adventurous", "bpm": 126, "scale": "minor", "root": 57,
        "art": "mountains", "palette": ["#4ade80", "#14532d"],
        "tracks": ["Overworld", "Cave of Echoes", "Mini Boss", "Victory Fanfare"],
    },
    {
        "id": "nimbus", "title": "Nimbus", "artist": "Ambient Cloud", "year": 2024,
        "genre": "Ambient", "mood": "calm", "bpm": 70, "scale": "major", "root": 64,
        "art": "waves", "palette": ["#a5b4fc", "#0f766e"],
        "tracks": ["Upload", "Cumulus", "Sync Complete", "Offline Mode"],
    },
    {
        "id": "groove-machine", "title": "Groove Machine", "artist": "Funk Byte", "year": 2023,
        "genre": "Funk", "mood": "groovy", "bpm": 104, "scale": "dorian", "root": 52,
        "art": "rings", "palette": ["#facc15", "#9a3412"],
        "tracks": ["Bass Overflow", "Slap Protocol", "Funky Kernel", "Interrupt Handler"],
    },
    {
        "id": "cafe-raspberry", "title": "Café Raspberry", "artist": "The Jazz Pis", "year": 2021,
        "genre": "Jazz", "mood": "cozy", "bpm": 92, "scale": "mixolydian", "root": 58,
        "art": "waves", "palette": ["#fda4af", "#78350f"],
        "tracks": ["Espresso Loop", "Blue Note SD Card", "Swing Thread", "Closing Time"],
    },
]

# Built-in games. Everything else is installed from the Game Store (store_catalog.py).
GAMES = [
    {
        "id": "pi-snake", "title": "π Snake", "platform": "aPiStation", "genre": "Arcade",
        "players": "1", "year": 2026, "art": "grid", "palette": ["#22d3ee", "#7c3aed"],
        "launch": {"type": "builtin", "game": "snake"},
        "description": "Built into the console. Eat the π symbols, grow, beat your high score for bonus XP.",
    },
]

HOME_DEVICES = [
    {"id": "living_light", "name": "Living Room Lights", "room": "Living Room", "type": "light",
     "on": True, "brightness": 70, "color": "#ffd8a8"},
    {"id": "led_strip", "name": "TV LED Strip", "room": "Living Room", "type": "light",
     "on": True, "brightness": 55, "color": "#8b5cf6"},
    {"id": "tv", "name": "Living Room TV", "room": "Living Room", "type": "media", "on": True},
    {"id": "desk_lamp", "name": "Desk Lamp", "room": "Office", "type": "light",
     "on": False, "brightness": 100, "color": "#e0f2fe"},
    {"id": "thermostat", "name": "Thermostat", "room": "Hallway", "type": "climate",
     "on": True, "target": 22.0, "current": 21.4},
    {"id": "coffee", "name": "Coffee Maker", "room": "Kitchen", "type": "switch", "on": False},
    {"id": "purifier", "name": "Air Purifier", "room": "Bedroom", "type": "fan", "on": True, "speed": 2},
    {"id": "front_door", "name": "Front Door", "room": "Hallway", "type": "lock", "on": True},
]

HOME_SCENES = [
    {"id": "movie_night", "name": "Movie Night", "icon": "film", "hue": 270,
     "description": "Lights dimmed, purple LEDs, TV on.",
     "states": {"living_light": {"on": True, "brightness": 12, "color": "#ffb37a"},
                "led_strip": {"on": True, "brightness": 60, "color": "#7c3aed"},
                "tv": {"on": True}, "desk_lamp": {"on": False}}},
    {"id": "focus", "name": "Focus Mode", "icon": "target", "hue": 200,
     "description": "Cool bright light at the desk, everything else calm.",
     "states": {"desk_lamp": {"on": True, "brightness": 100, "color": "#e0f2fe"},
                "living_light": {"on": True, "brightness": 40, "color": "#f1f5f9"},
                "led_strip": {"on": False}, "tv": {"on": False}}},
    {"id": "party", "name": "Party", "icon": "sparkles", "hue": 320,
     "description": "Full brightness and pink neon.",
     "states": {"living_light": {"on": True, "brightness": 100, "color": "#fbcfe8"},
                "led_strip": {"on": True, "brightness": 100, "color": "#ec4899"},
                "tv": {"on": True}}},
    {"id": "morning", "name": "Good Morning", "icon": "sun", "hue": 40,
     "description": "Warm lights and the coffee already brewing.",
     "states": {"living_light": {"on": True, "brightness": 75, "color": "#ffe8b0"},
                "coffee": {"on": True}, "thermostat": {"target": 22.5}}},
    {"id": "good_night", "name": "Good Night", "icon": "moon", "hue": 230,
     "description": "Everything off, door locked, heating lowered.",
     "states": {"living_light": {"on": False}, "led_strip": {"on": False}, "desk_lamp": {"on": False},
                "tv": {"on": False}, "coffee": {"on": False}, "front_door": {"on": True},
                "thermostat": {"target": 19.0}}},
]

PROFILES = [
    {"id": "bogdan", "name": "Bogdan", "hue": 265},
    {"id": "alex", "name": "Alex", "hue": 175},
]
