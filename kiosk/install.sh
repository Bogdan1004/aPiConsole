#!/usr/bin/env bash
# Makes the Pi boot straight into aPiStation on the HDMI screen.
#   1. Python venv + dependencies for the hub
#   2. hub as a systemd user service (starts at boot)
#   3. labwc autostart that opens only the console (no desktop, no panel)
# Undo with kiosk/uninstall.sh.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
HUB="$REPO/hub"
LABWC="$HOME/.config/labwc"
UNIT_DIR="$HOME/.config/systemd/user"

if [ "$REPO" != "$HOME/aPiConsole" ]; then
  echo "Expected the repo at ~/aPiConsole (found $REPO). Edit kiosk/apistation-hub.service if you moved it." >&2
  exit 1
fi

echo "==> Hub dependencies"
[ -d "$HUB/.venv" ] || python3 -m venv "$HUB/.venv"
"$HUB/.venv/bin/pip" install -q -r "$HUB/requirements.txt"
[ -f "$HUB/.env" ] || cp "$HUB/.env.example" "$HUB/.env"

echo "==> Hub service"
mkdir -p "$UNIT_DIR"
cp "$REPO/kiosk/apistation-hub.service" "$UNIT_DIR/"
systemctl --user daemon-reload
systemctl --user enable --now apistation-hub.service
# Keep user services running from boot, before anyone logs in.
loginctl enable-linger "$USER" 2>/dev/null || echo "   (could not enable linger; the hub will start at login instead)"

echo "==> Kiosk autostart"
mkdir -p "$LABWC"
if [ -f "$LABWC/autostart" ] && ! grep -q "aPiStation" "$LABWC/autostart"; then
  cp "$LABWC/autostart" "$LABWC/autostart.before-apistation"
fi
chmod +x "$REPO/kiosk/start-kiosk.sh"
cat > "$LABWC/autostart" <<EOF
# aPiStation kiosk (installed by kiosk/install.sh; undo with kiosk/uninstall.sh)
/usr/bin/kanshi &
$REPO/kiosk/start-kiosk.sh &
EOF

if [ -f "$LABWC/rc.xml" ] && ! grep -q "aPiStation" "$LABWC/rc.xml"; then
  cp "$LABWC/rc.xml" "$LABWC/rc.xml.before-apistation"
fi
cp "$REPO/kiosk/labwc-rc.xml" "$LABWC/rc.xml"

echo
echo "Done. Reboot to land in aPiStation:  sudo reboot"
echo "Hub logs:   journalctl --user -u apistation-hub -f"
echo "Back to the normal desktop:  $REPO/kiosk/uninstall.sh"
