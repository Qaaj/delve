#!/bin/bash
# One-command install for macOS + Docker Desktop. Run from inside this
# project directory (or see README's "making this a real curl one-liner"
# section for turning this into something a fresh clone can pipe straight
# into bash).
set -e

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker isn't installed. Get Docker Desktop first: https://www.docker.com/products/docker-desktop/"
  echo "Then run this script again."
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker is installed, but the 'docker compose' plugin isn't available."
  echo "Docker Desktop includes it automatically — try updating Docker Desktop."
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker is installed but doesn't seem to be running. Open Docker Desktop, wait for it to finish starting, then run this script again."
  exit 1
fi

echo "Building and starting delve..."
docker compose up -d --build

echo ""
echo "Waiting for it to come up..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:4310/ >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo ""
echo "Ready. Opening http://localhost:4310 — you'll land on a short setup page"
echo "asking for your Proton Bridge username/password (Bridge -> your account"
echo "-> Mailbox configuration). Don't have Bridge installed yet? Get it here"
echo "first, log in, then come back: https://proton.me/mail/bridge"
echo ""

open http://localhost:4310 2>/dev/null || echo "Open this yourself: http://localhost:4310"
