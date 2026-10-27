#!/usr/bin/env bash
# Installs the free local LLM behind the aPiStation assistant: llama.cpp's server and Qwen2.5 1.5B Instruct
# (Apache 2.0, ~1.1 GB). Runs on the Pi itself, so chatting costs no tokens and works offline.
# No sudo: everything goes into ~/.local/share/apistation/llm. About 20-30 minutes on a Pi 4, mostly compiling.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DIR="${APISTATION_LLM_DIR:-$HOME/.local/share/apistation/llm}"
MODEL_URL="https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf"
MODEL="$DIR/models/qwen2.5-1.5b-instruct-q4_k_m.gguf"

mkdir -p "$DIR/models"

echo "==> Downloading the model (Qwen2.5 1.5B Instruct, Q4_K_M)"
if [ ! -f "$MODEL" ]; then
  curl -L --fail --retry 3 -C - -o "$MODEL.part" "$MODEL_URL"
  mv "$MODEL.part" "$MODEL"
fi

echo "==> Getting llama.cpp (latest release)"
if [ ! -x "$DIR/llama-server" ]; then
  # CMake from PyPI: the Debian package would need sudo.
  [ -x "$DIR/venv/bin/cmake" ] || { python3 -m venv "$DIR/venv" && "$DIR/venv/bin/pip" install -q cmake; }
  TAG="${LLAMA_TAG:-$(git ls-remote --tags --refs https://github.com/ggml-org/llama.cpp | grep -oE 'refs/tags/b[0-9]+$' | sed 's#refs/tags/##' | sort -V | tail -1)}"
  echo "    llama.cpp $TAG"
  rm -rf "$DIR/src"
  git clone --quiet --depth 1 --branch "$TAG" https://github.com/ggml-org/llama.cpp "$DIR/src"
  echo "==> Compiling llama-server (the long part)"
  "$DIR/venv/bin/cmake" -S "$DIR/src" -B "$DIR/src/build" -DCMAKE_BUILD_TYPE=Release \
    -DLLAMA_CURL=OFF -DBUILD_SHARED_LIBS=OFF -DLLAMA_BUILD_TESTS=OFF -DGGML_NATIVE=ON >/dev/null
  "$DIR/venv/bin/cmake" --build "$DIR/src/build" --target llama-server -j "$(nproc)"
  cp "$DIR/src/build/bin/llama-server" "$DIR/llama-server"
  echo "$TAG" > "$DIR/VERSION"
fi

echo "==> Starting the apistation-llm service"
mkdir -p "$HOME/.config/systemd/user"
cp "$REPO_DIR/kiosk/apistation-llm.service" "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable --now apistation-llm.service
systemctl --user restart apistation-llm.service

echo "Done. The assistant now answers with the local model (http://127.0.0.1:8421)."
