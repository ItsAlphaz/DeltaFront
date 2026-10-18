#!/usr/bin/env bash
# Runs a command against a PRIVATE copy of the game, so the playtest scripts never
# touch your dev server:
#
#   scripts/playtest/stack.sh node scripts/playtest/golden.mjs
#
# It copies the working tree (and node_modules) to a temp directory, starts Vite
# (port 9000) and the game server (3000-3002) from the COPY inside a private
# network namespace (`unshare -Urn`, so those ports are free even while your own
# dev server is running), runs the command, and stops everything.
#
# Why a copy: a second Vite on your checkout would re-optimise node_modules/.vite
# ("vite config has changed") and break the page of the dev server that is running.
# Why a namespace: the dev client hard-codes ports 9000 and 3000-3002.
#
# Environment: PLAYTEST_OUT (screenshots and logs, default $TMPDIR/deltafront-playtest-out),
# PLAYTEST_COPY (where the copy lives), PLAYTEST_LOGTAG (log file prefix).
# Needs: Linux with unprivileged user namespaces, `ip`, `ss`, google-chrome-stable, a display.
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
TMP=${TMPDIR:-/tmp}
COPY=${PLAYTEST_COPY:-$TMP/deltafront-playtest-copy}
OUT=${PLAYTEST_OUT:-$TMP/deltafront-playtest-out}
TAG=${PLAYTEST_LOGTAG:-stack}
export PLAYTEST_OUT="$OUT"

if [ "${1:-}" != "--inside" ]; then
    [ $# -gt 0 ] || {
        sed -n '2,20p' "$0"
        exit 2
    }
    mkdir -p "$OUT" "$COPY"
    # The sources are refreshed every time (they change); node_modules once.
    rm -rf "$COPY/src" "$COPY/packages" "$COPY/resources" "$COPY/scripts"
    (cd "$ROOT" && tar --exclude=./.git --exclude=./.account-api-dev --exclude=./node_modules \
        --exclude=./static --exclude=./coverage --exclude=./tests -cf - .) | tar -xf - -C "$COPY"
    [ -d "$COPY/node_modules" ] || cp -a "$ROOT/node_modules" "$COPY/node_modules"
    exec unshare -Urn bash "$0" --inside "$@"
fi
shift # --inside

ip link set lo up
cd "$COPY" || exit 1
export SKIP_BROWSER_OPEN=true
setsid env GAME_ENV=dev npx vite > "$OUT/$TAG-vite.log" 2>&1 &
VITE=$!
setsid env GAME_ENV=dev TURNSTILE_SITE_KEY=1x00000000000000000000AA \
    API_KEY=WARNING_DEV_API_KEY_DO_NOT_USE_IN_PRODUCTION \
    ADMIN_BOT_API_KEY=WARNING_DEV_ADMIN_BOT_KEY_DO_NOT_USE_IN_PRODUCTION \
    DOMAIN=localhost GIT_COMMIT=DEV npx tsx src/server/Server.ts > "$OUT/$TAG-server.log" 2>&1 &
SERVER=$!
cleanup() {
    kill -- -"$VITE" -"$SERVER" 2> /dev/null
    sleep 1
    kill -9 -- -"$VITE" -"$SERVER" 2> /dev/null
}
trap cleanup EXIT
for i in $(seq 1 180); do
    if ss -ltn | grep -q ':9000 ' && ss -ltn | grep -q ':3001 '; then break; fi
    sleep 1
done
echo "private stack up after ${i}s (Vite 9000, game server 3000-3002); logs in $OUT"
cd "$ROOT" || exit 1
"$@"
