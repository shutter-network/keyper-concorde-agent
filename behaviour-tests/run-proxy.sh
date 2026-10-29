#!/bin/sh
# Usage: ./run-proxy.sh
# Uses a fake Anthropic API and a dummy key. Does not read .env and makes no model API calls.
set -eu
cd "$(dirname "$0")"
status=0
docker compose -f compose.proxy.yml run --build --rm --use-aliases runner node --test behaviour-tests/proxy.test.mts || status=$?
docker compose -f compose.proxy.yml down
exit "$status"
