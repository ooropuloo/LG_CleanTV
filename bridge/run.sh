#!/bin/sh
# Build and (re)start the tv-home container on the HA host. Run from anywhere:  sh bridge/run.sh
# Needs bridge/.env (copy .env.example). cats/ and web/ are also mounted read-only, so updating a cat
# scene or the page only needs a file copy + TV reload, not a rebuild.
set -e
cd "$(dirname "$0")/.."
[ -f bridge/.env ] || { echo "missing bridge/.env (copy bridge/.env.example)"; exit 1; }
[ -f bridge/config.json ] || { echo "missing bridge/config.json (cp bridge/config.example.json bridge/config.json, then edit)"; exit 1; }
# scene factory (factory/README.md): its state is read-only for the bridge, only the request inbox is writable
mkdir -p factory-data/state factory-data/inbox && chown 1000:1000 factory-data factory-data/state factory-data/inbox 2>/dev/null || true
docker build -f bridge/Dockerfile -t tv-home .
docker rm -f tv-home 2>/dev/null || true
docker run -d --name tv-home \
  --net=host --restart unless-stopped \
  --env-file bridge/.env \
  -v "$PWD/web:/app/web:ro" -v "$PWD/cats:/app/cats:ro" -v "$PWD/bridge/config.json:/app/bridge/config.json:ro" \
  -v "$PWD/factory-data/state:/app/factory/state:ro" -v "$PWD/factory-data/inbox:/app/factory/inbox" \
  tv-home
docker image prune -f --filter label=tv-home=1 >/dev/null   # the previous build is now dangling (disk budget)
docker logs --tail 20 tv-home
