#!/bin/bash
# One-time setup so the Game Store can install and remove PC games without asking for a password.
# Run it with:  sudo ~/aPiConsole/kiosk/setup-store.sh
# It installs a small helper that only accepts the game packages listed in the Store catalog,
# and a sudoers rule that lets your user run that helper (and nothing else) without a password.
# Run it again after adding games to hub/app/store_catalog.py. Undo: sudo kiosk/setup-store.sh --remove
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo: sudo $0" >&2; exit 1; }
USER_NAME="${SUDO_USER:?run this with sudo from your normal user}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
RULE=/etc/sudoers.d/apistation-store

if [ "${1:-}" = "--remove" ]; then
  rm -f "$RULE" /usr/local/sbin/apistation-pkg
  rm -rf /etc/apistation
  echo "Store permissions removed."
  exit 0
fi

# Package names come from apt([...]) entries in the catalog; parsed as text, never executed as root.
mkdir -p /etc/apistation
grep -oE 'apt\(\[[^]]*\]' "$REPO/hub/app/store_catalog.py" \
  | grep -oE '"[a-z0-9][a-z0-9+.-]+"' | tr -d '"' | sort -u > /etc/apistation/store-packages
chmod 644 /etc/apistation/store-packages

install -o root -g root -m 755 "$REPO/kiosk/apistation-pkg" /usr/local/sbin/apistation-pkg

TMP="$(mktemp)"
echo "$USER_NAME ALL=(root) NOPASSWD: /usr/local/sbin/apistation-pkg" > "$TMP"
visudo -cf "$TMP" >/dev/null
install -o root -g root -m 440 "$TMP" "$RULE"
rm -f "$TMP"

echo "Game Store can now install these packages for $USER_NAME:"
tr '\n' ' ' < /etc/apistation/store-packages; echo
