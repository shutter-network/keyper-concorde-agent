#!/bin/sh
# Usage: ./run.sh [scenario|all|proxy] (default: scheduling)
#
# `proxy` checks the LiteLLM proxy against a fake Anthropic API with a dummy key. It does not read
# .env and makes no model API calls. Every other choice reads the provider keys from the
# deployment's .env through compose's own parser; only the litellm service receives them.
set -eu
cd "$(dirname "$0")"
scenario="${1:-scheduling}"
if [ "$scenario" = proxy ]; then
  export ANTHROPIC_API_KEY=dummy-provider-key ANTHROPIC_API_BASE=http://runner:8090
  export LOCAL_API_BASE= LOCAL_API_KEY= RUNNER_PROVIDER_KEY=dummy-provider-key
  compose="docker compose -f compose.behaviour.yml"
  set -- behaviour-tests/proxy.test.mts
else
  # Send Claude models to Anthropic itself, never to an address left from a proxy run.
  export ANTHROPIC_API_BASE=
  env_file=""
  if [ -f ../.env ]; then env_file="--env-file ../.env"; fi
  compose="docker compose $env_file -f compose.behaviour.yml"
  if [ "$scenario" = all ]; then
    set -- behaviour-tests/scenarios.test.mts
  else
    set -- --test-name-pattern="^${scenario}\$" behaviour-tests/scenarios.test.mts
  fi
fi
# A litellm left running from the other mode would keep that mode's keys, so start a fresh one.
$compose up -d --force-recreate --wait litellm
exec $compose run --build --rm --use-aliases runner node --test "$@"
