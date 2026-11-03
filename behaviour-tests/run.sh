#!/bin/sh
# Usage: ./run.sh [scenario|all|proxy] (default: scheduling)
#
# Proxy tests use a fake Anthropic API and dummy credentials, with no paid model calls.
# Behaviour scenarios load provider credentials from the deployment's .env through Docker Compose
# and pass them only to LiteLLM.
set -eu
cd "$(dirname "$0")"
scenario="${1:-scheduling}"
if [ "$scenario" = proxy ]; then
  export ANTHROPIC_API_KEY=dummy-provider-key ANTHROPIC_API_BASE=http://runner:8090
  export LOCAL_API_BASE= LOCAL_API_KEY= RUNNER_PROVIDER_KEY=dummy-provider-key
  compose="docker compose -f compose.behaviour.yml"
  set -- behaviour-tests/proxy.test.mts
else
  # Clear the fake upstream override for real-model tests.
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
# Recreate LiteLLM to apply the credentials and endpoint for this test mode.
$compose up -d --force-recreate --wait litellm
exec $compose run --build --rm --use-aliases runner node --test "$@"
