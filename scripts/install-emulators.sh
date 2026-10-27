#!/usr/bin/env bash
# Installs RetroArch + emulator cores from Debian and downloads free homebrew games into ~/roms.
# Your own games go in ~/roms/<platform>/ (nes, snes, gb, gbc, gba, md, sms, gg, nds, psx, n64)
# and appear in the console within a minute.
set -euo pipefail

echo "==> RetroArch and cores (NES, SNES, Game Boy/Color, GBA, Mega Drive/Master System/Game Gear)"
sudo apt-get install -y --no-install-recommends \
  retroarch retroarch-assets libretro-core-info \
  libretro-nestopia libretro-snes9x libretro-gambatte libretro-mgba libretro-genesisplusgx

echo "==> Free homebrew games (official releases from their authors)"
ROMS="${APISTATION_ROMS:-$HOME/roms}"
mkdir -p "$ROMS"/{nes,snes,gb,gbc,gba,md,sms,gg,nds,psx,n64}
get() { [ -f "$ROMS/$1" ] || curl -fsSL -o "$ROMS/$1" "$2" && echo "   $1"; }
get gbc/ucity.gbc   https://github.com/AntonioND/ucity/releases/download/v1.3/ucity.gbc
get gb/libbet.gb    https://github.com/pinobatch/libbet/releases/download/v0.08/libbet.gb
get nes/nova.nes    https://github.com/NovaSquirrel/NovaTheSquirrel/releases/download/v1.0.6a/nova.nes
get nes/thwaite.nes https://github.com/pinobatch/thwaite-nes/releases/download/v0.04/thwaite.nes
get md/cavestory.gen https://github.com/andwn/cave-story-md/releases/download/v0.8.8/doukutsu-en.gen

echo
echo "Done. In a game: hold Start + Select to return to aPiStation."
