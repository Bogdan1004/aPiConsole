#!/usr/bin/env bash
# Public demo link for aPiStation through a free Cloudflare quick tunnel: no account, no sudo, no open ports.
# Visitors can only use the read-only Guest profile: Bogdan and Alex need their PIN, and a first PIN can only be
# created from the home network. The address changes every time the tunnel starts; it never starts at boot.
#
# usage: scripts/public-link.sh start | stop | url | status
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$HOME/.local/bin/cloudflared"
VERSION="${CLOUDFLARED_VERSION:-2026.10.5}"
LOG="$HOME/.local/share/apistation/tunnel.log"

url() { grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$LOG" 2>/dev/null | tail -1 || true; }

case "${1:-start}" in
  start)
    if [ ! -x "$BIN" ]; then
      arch=$(uname -m); case "$arch" in aarch64) arch=arm64 ;; armv7l) arch=arm ;; x86_64) arch=amd64 ;; esac
      mkdir -p "$(dirname "$BIN")"
      curl -fL -o "$BIN.part" "https://github.com/cloudflare/cloudflared/releases/download/$VERSION/cloudflared-linux-$arch"
      chmod +x "$BIN.part" && mv "$BIN.part" "$BIN"
    fi
    mkdir -p "$(dirname "$LOG")" "$HOME/.config/systemd/user"
    cp "$REPO_DIR/kiosk/apistation-tunnel.service" "$HOME/.config/systemd/user/"
    systemctl --user daemon-reload
    systemctl --user restart apistation-tunnel.service
    for _ in $(seq 1 40); do [ -n "$(url)" ] && break; sleep 1; done
    if [ -n "$(url)" ]; then echo "Public link (Guest only): $(url)"; else echo "No link yet; see $LOG"; exit 1; fi
    ;;
  stop)
    systemctl --user stop apistation-tunnel.service
    echo "Public link closed."
    ;;
  url)
    url
    ;;
  status)
    systemctl --user is-active apistation-tunnel.service || true
    url
    ;;
  *)
    echo "usage: $0 start | stop | url | status" >&2
    exit 2
    ;;
esac
