#!/usr/bin/env bash
# Builds both contracts to build/. The token is built first because the launchpad embeds it.
# wasm-opt (binaryen) shrinks them by about a fifth; without it the unshrunk files are used.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=target/wasm32-unknown-unknown/release
mkdir -p build

shrink() { # shrink <in> <out>
  if command -v wasm-opt >/dev/null 2>&1; then
    wasm-opt -Oz --enable-bulk-memory --enable-sign-ext --enable-mutable-globals \
      --enable-nontrapping-float-to-int --enable-multivalue --enable-reference-types "$1" -o "$2"
  else
    echo "wasm-opt not found: using the unshrunk wasm" >&2
    cp "$1" "$2"
  fi
}

cargo build --release --target wasm32-unknown-unknown -p copylaunch-token
shrink "$OUT/copylaunch_token.wasm" build/copylaunch_token.wasm
cargo build --release --target wasm32-unknown-unknown -p copylaunch
shrink "$OUT/copylaunch.wasm" build/copylaunch.wasm

for f in build/copylaunch_token.wasm build/copylaunch.wasm; do
  printf '%s  %s bytes  sha256 %s\n' "$f" "$(wc -c <"$f" | tr -d ' ')" "$(shasum -a 256 "$f" | cut -d' ' -f1)"
done
