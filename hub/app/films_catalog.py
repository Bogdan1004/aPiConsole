"""Films that are legal to download for free, matched on Internet Archive.

Two hand-checked lists only (an archive item's own license tag is never trusted on its own):
- Creative Commons films released as such by their makers (the Blender open movies);
- public-domain classics that are free in Romania / the EU too: every director, writer and composer
  died more than 70 years ago. US-only public domain films (lapsed notices, e.g. Night of the
  Living Dead) are deliberately left out.
"""

PUBLIC_DOMAIN = [
    {"title": "A Trip to the Moon", "year": 1902, "note": "Georges Méliès (d. 1938)"},
    {"title": "The Great Train Robbery", "year": 1903, "note": "Edwin S. Porter (d. 1941)"},
    {"title": "Intolerance", "year": 1916, "note": "D. W. Griffith (d. 1948)"},
    {"title": "The Cabinet of Dr. Caligari", "year": 1920, "note": "Robert Wiene (d. 1938), writers d. 1944 and 1954"},
    {"title": "Nosferatu", "year": 1922, "note": "F. W. Murnau (d. 1931), Henrik Galeen (d. 1949)"},
    {"title": "Nanook of the North", "year": 1922, "note": "Robert J. Flaherty (d. 1951)"},
    {"title": "The Last Laugh", "year": 1924, "note": "F. W. Murnau (d. 1931), Carl Mayer (d. 1944)"},
    {"title": "Battleship Potemkin", "year": 1925, "note": "Sergei Eisenstein (d. 1948)"},
    {"title": "Faust", "year": 1926, "note": "F. W. Murnau (d. 1931), Hans Kyser (d. 1940)"},
    {"title": "Sunrise", "year": 1927, "note": "F. W. Murnau (d. 1931), Carl Mayer (d. 1944)"},
]

CREATIVE_COMMONS = [
    {"title": "Big Buck Bunny", "year": 2008},
    {"title": "Elephants Dream", "year": 2006},
    {"title": "Sintel", "year": 2010},
    {"title": "Tears of Steel", "year": 2012},
]

# Internet Archive collections that hold the public-domain features above.
PD_COLLECTIONS = ["feature_films", "silent_films", "short_films"]
