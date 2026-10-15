#!/bin/sh
# Usage: ./run.sh [scenario|all] (default: scheduling)
set -eu
cd "$(dirname "$0")"
# Provider keys come from the deployment's .env through compose's own parser.
env_file=""
if [ -f ../.env ]; then env_file="--env-file ../.env"; fi
scenario="${1:-scheduling}"
if [ "$scenario" = all ]; then
  set -- behaviour-tests/scenarios.test.mts
else
  set -- --test-name-pattern="^${scenario}\$" behaviour-tests/scenarios.test.mts
fi
exec docker compose $env_file -f compose.behaviour.yml run --build --rm --use-aliases runner node --test "$@"
