#!/bin/sh
# Usage: ./run.sh [scenario|all] (default: scheduling)
set -eu
cd "$(dirname "$0")"
scenario="${1:-scheduling}"
if [ "$scenario" = all ]; then
  set -- behaviour-tests/scenarios.test.mts
else
  set -- --test-name-pattern="^${scenario}\$" behaviour-tests/scenarios.test.mts
fi
exec docker compose -f compose.behaviour.yml run --build --rm --use-aliases runner node --test "$@"
