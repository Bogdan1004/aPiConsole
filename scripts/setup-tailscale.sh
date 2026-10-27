#!/usr/bin/env bash
# Remote access for aPiStation with Tailscale (free):
#   - private: your own devices (and people you invite) reach the Pi at http://apiconsole:8420 from anywhere;
#   - Funnel: a fixed public HTTPS link, https://apiconsole.<your-tailnet>.ts.net, where visitors only get Guest.
# Needs sudo once (package + login). Funnel stays on across reboots; turn it off with: tailscale funnel --https=443 off
set -euo pipefail

. /etc/os-release
if ! command -v tailscale >/dev/null; then
  echo "==> Adding Tailscale's package repository for Debian $VERSION_CODENAME and installing it"
  curl -fsSL "https://pkgs.tailscale.com/stable/debian/$VERSION_CODENAME.noarmor.gpg" \
    | sudo tee /usr/share/keyrings/tailscale-archive-keyring.gpg >/dev/null
  curl -fsSL "https://pkgs.tailscale.com/stable/debian/$VERSION_CODENAME.tailscale-keyring.list" \
    | sudo tee /etc/apt/sources.list.d/tailscale.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y tailscale
fi

echo "==> Connecting this Pi to your Tailscale account (open the link it prints and log in)"
# --operator lets your user run "tailscale funnel/status" later without sudo (the hub reads the status too).
sudo tailscale up --operator="$USER" --hostname=apiconsole

echo "==> Turning on the public link (Funnel) for the console on port 8420"
echo "    If it asks you to enable Funnel or HTTPS for your tailnet, open that link, allow it, and it carries on."
tailscale funnel --bg 8420

echo
tailscale funnel status
echo "Done. Private: http://apiconsole:8420 on your Tailscale devices. Public (Guest only): the https link above."
