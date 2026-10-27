#!/usr/bin/env bash
# Restores the normal Raspberry Pi desktop and stops the hub service.
set -euo pipefail

LABWC="$HOME/.config/labwc"

if [ -f "$LABWC/autostart.before-apistation" ]; then
  mv "$LABWC/autostart.before-apistation" "$LABWC/autostart"
elif [ -f "$LABWC/autostart" ] && grep -q "aPiStation" "$LABWC/autostart"; then
  rm "$LABWC/autostart"
fi

if [ -f "$LABWC/rc.xml.before-apistation" ]; then
  mv "$LABWC/rc.xml.before-apistation" "$LABWC/rc.xml"
elif [ -f "$LABWC/rc.xml" ] && grep -q "aPiStation" "$LABWC/rc.xml"; then
  rm "$LABWC/rc.xml"
fi

systemctl --user disable --now apistation-hub.service 2>/dev/null || true
rm -f "$HOME/.config/systemd/user/apistation-hub.service"
systemctl --user daemon-reload

echo "Desktop restored. Reboot to apply:  sudo reboot"
