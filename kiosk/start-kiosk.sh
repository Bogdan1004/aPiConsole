#!/usr/bin/env bash
# Opens the aPiStation console full screen on the TV and reopens it if Chromium exits.
# Started by labwc at login (see kiosk/install.sh).
set -u

HUB_URL="${APISTATION_URL:-http://localhost:8420}"
PROFILE_DIR="$HOME/.config/apistation-kiosk"

# Wait for the hub (it starts as a systemd user service).
for _ in $(seq 1 60); do
  curl -fs "$HUB_URL/api/health" >/dev/null && break
  sleep 1
done

while true; do
  # --password-store=basic: without it Chromium waits for the desktop keyring,
  # which never unlocks in a kiosk session, and pages never load.
  chromium \
    --kiosk "$HUB_URL/?kiosk=1" \
    --ozone-platform=wayland \
    --password-store=basic \
    --user-data-dir="$PROFILE_DIR" \
    --autoplay-policy=no-user-gesture-required \
    --noerrdialogs \
    --disable-infobars \
    --disable-session-crashed-bubble \
    --disable-features=Translate,TranslateUI \
    --no-first-run \
    --check-for-update-interval=31536000 \
    --overscroll-history-navigation=0 \
    >/dev/null 2>&1
  sleep 2
done
