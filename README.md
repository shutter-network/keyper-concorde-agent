# Keyper Concorde Agent

Prototype. A Concorde deployment that lets Shutter keyper operators talk to one agent over
Telegram, with every message recorded per user in the gateway. Runs on one droplet. No operator
is connected yet; the only user is the person testing it.

Built from `examples/00_minimal` of `shutter-network/concorde` at commit `e3f746e`, with:

- `telegram-channel/`, a Channel for the Telegram Bot API, written against the Messenger's
  Channel contract and modelled on the framework's Nostr Channel. It replaces the HTTP Channel.
  Meant to move into Concorde as `@shutter-network/concorde/telegram-channel` once it has run.
- `main.ts` mounts `models.json` in the agent container without passing it any model API keys.
  It links the tester's chat to the initial user when the gateway starts.
- the `litellm` service stores the model API keys and adds them to requests sent to providers.
  The agent has no model API keys. See [The model proxy](#the-model-proxy).
- `settings.json` and `models.json` set the model and tell pi to use the proxy. Each machine
  has its own copies, made from the `.example` files. These copies are never committed.
- `AGENTS.md` adds the Grafana dashboard instructions.

## The framework dependency

`@shutter-network/concorde` is not on npm yet (issue 01 on the Concorde review). Until it is,
the image installs it from a tarball in `vendor/` that is never committed: `.gitignore` excludes
it, and each machine that builds the image produces its own.

```sh
cd path/to/concorde && git checkout e3f746e && npm ci && npm run build && npm pack
mv shutter-network-concorde-0.1.0.tgz path/to/this/repo/vendor/
```

When the package is published, `package.json` goes back to `"^0.1.0"` and `vendor/` is deleted.

## The model proxy

The `litellm` service stores the model API keys and adds the correct key to each request it
sends to a provider. Neither the agent nor the gateway receives these keys. The agent cannot
find any model API keys by reading its environment.

Three files configure the proxy and its connection to pi:

| file | role | in git? |
|---|---|---|
| `litellm-config.yaml` | sends requests for any `claude-*` model to Anthropic and all other models to `LOCAL_API_BASE` | yes |
| `models.json` | tells pi to send requests to the proxy instead of directly to the provider | no, each machine has its own copy |
| `.env` | stores the real model API keys and the local endpoint, which only the proxy reads | no, each machine has its own copy |

### Updating the configuration and switching models

**Replace the old `models.json` on every machine, including the droplet.** Copy the new
`models.json.example` to `models.json`. If you keep the old endpoint and a real API key in
`models.json`, requests still work, but the agent still has the key. There is no warning.

**`switch-model.sh` does not check which provider a model ID belongs to.** It changes only the
model ID in `settings.json` and `models.json`; it does not change other settings in those files.
The proxy sends requests for any `claude-*` ID to Anthropic and all other IDs to `LOCAL_API_BASE`.
You can safely switch between two Claude models or between two local models. When switching
providers, check that the new provider's key is set. If you switch to a local model without
setting `LOCAL_API_KEY`, the switch succeeds, but the first agent run fails.

## Before the first run

1. Put the tarball in `vendor/` as above.
2. `cp .env.example .env` and fill in `LOCAL_API_BASE`, `LOCAL_API_KEY`, `USER_PASSWORD`,
   `TG_TOKEN`, and `TG_CHAT`. If you use Anthropic, set `ANTHROPIC_API_KEY` and leave
   `LOCAL_API_BASE` and `LOCAL_API_KEY` blank. You still need the other values.
3. `cp models.json.example models.json` and `cp settings.json.example settings.json`, then put
   your model id in both. Store the endpoint and API key in `.env`, where the proxy reads them.
   The agent does not read these values. Use a placeholder key in `models.json`, never a real key.
4. If another process polls the same bot token, stop it first. Telegram hands each update to
   one poller, and the Channel logs a 409 until the other one is gone.

## Run

```sh
docker compose up -d --build
docker compose logs -f gateway
```

Expected at boot: `user <id> logs in with the password ...`, then
`telegram chat <TG_CHAT> now belongs to user <id>`. Message the bot; the reply comes back in
the same chat.

## Users

A message from a chat that belongs to no user gets one answer, its own chat id, and nothing is
recorded. That is how a new operator learns the id to send the team. `admin.ts` does the rest,
against the database, with or without the gateway running:

```sh
docker compose run --rm --no-deps gateway node admin.ts list
docker compose run --rm --no-deps gateway node admin.ts add <name> <chatId>
docker compose run --rm --no-deps gateway node admin.ts detach <userId>
```

`add` creates the user, names them and attaches the chat in one transaction. `detach` removes
the chat only: the framework removes no user, and the message log stays. A group chat works as
a user too; its id is negative.

## Tests

`telegram-channel/telegram-channel.test.ts` runs the Channel against a real PostgreSQL and a
fake Bot API on localhost (`fake-bot-api.ts`): recording chats, inbound texts and redelivery,
unknown chats, outbound replies, refusals, transient failures, splitting, a reply queued while
stopped, a 409 from a second poller, stop and start. The helpers in `test-support.ts` mirror
the framework's own.

Against the stack's database, without starting the gateway:

```sh
docker compose run --rm test
```

Or anywhere with Node 24 and a PostgreSQL to create databases on:

```sh
DATABASE_URL=postgres://user:password@host:5432/postgres npm test
```

## Operating notes

- The model is chosen in `settings.json` and described in `models.json`. After changing the
  model, delete `state/agent/sessions/*`: pi sessions pin the model they started with.
  `./switch-model.sh <model-id>` does both in one step.
- A run that fails tells the sender "I could not process your last message" through the
  handler's `post` phase, and nothing more. The reason is in `docker compose logs gateway`, as
  the error on the `Run finished` line, and in the agent container's own log while it runs:
  `docker logs $(docker ps -q --filter ancestor=keyper-concorde-agent:0.83.0)`.
- If the model endpoint is down, every message looks like the agent is offline. Test the
  endpoint directly with a one-word chat completion before debugging this deployment. Set
  `BASE_URL` to `LOCAL_API_BASE` from `.env`, `API_KEY` to `LOCAL_API_KEY` from `.env`, and
  `MODEL` to the model ID from `settings.json`. This request skips the proxy and checks whether
  the provider itself is responding:

  ```sh
  curl -sS -m 60 -w '\nHTTP %{http_code} in %{time_total}s\n' \
    "$BASE_URL/chat/completions" \
    -H "authorization: Bearer $API_KEY" \
    -H "content-type: application/json" \
    -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with the single word OK.\"}],\"max_tokens\":50}"
  ```

  A healthy endpoint answers within seconds with `HTTP 200`. A timeout or `HTTP 000` means the
  box behind the proxy is down, and nothing in this repo can fix that.
- `docker compose down` keeps the database. `down -v` deletes it, including the user, its chat
  and the whole message log.

## Files

| file | role |
|---|---|
| `main.ts` | the deployment: runtime, components, handler, seeding |
| `telegram-channel/` | the Telegram Channel: schema, chats, outbox, Bot API, channel |
| `compose.yml` | gateway, litellm, migrate, postgres, agent image |
| `litellm-config.yaml` | sets the provider for each model name |
| `AGENTS.md` | the agent's instructions, mounted read-only |
| `settings.json`, `models.json` | pi's model configuration, mounted read-only |
| `schema.ts`, `drizzle.config.ts` | tables the deployment applies with drizzle-kit |
