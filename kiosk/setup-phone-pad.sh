#!/usr/bin/env bash
# One-time setup so a paired phone works as a real controller on the TV, games included: lets the hub create
# its virtual gamepad (Linux uinput) and gives RetroArch the pad's button layout. Run it once: it asks for sudo.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
USER_HOME="$HOME"

echo "==> RetroArch profile for the phone pad"
mkdir -p "$USER_HOME/.config/retroarch/autoconfig/udev"
cp "$REPO_DIR/kiosk/retroarch-autoconfig/"*.cfg "$USER_HOME/.config/retroarch/autoconfig/udev/"

echo "==> Letting the input group create virtual controllers (asks for your password)"
sudo tee /etc/udev/rules.d/60-apistation-uinput.rules >/dev/null <<'RULE'
# aPiStation: the hub (a member of the input group) creates the phone's virtual gamepad.
KERNEL=="uinput", SUBSYSTEM=="misc", GROUP="input", MODE="0660", OPTIONS+="static_node=uinput"
RULE
echo uinput | sudo tee /etc/modules-load.d/apistation-uinput.conf >/dev/null
sudo modprobe uinput || true
sudo udevadm control --reload-rules
# Apply now too, so no reboot is needed.
sudo chgrp input /dev/uinput
sudo chmod 660 /dev/uinput
id -nG "$USER" | grep -qw input || sudo usermod -aG input "$USER"

echo "Done. Pair your phone again from the TV's quick menu: it now works in games too."
