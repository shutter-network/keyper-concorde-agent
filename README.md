# Keyper Concorde Agent

Prototype. A Concorde deployment that lets Shutter keyper operators talk to one agent over
Telegram, with every message recorded per user in the gateway. Runs on one droplet. No operator
is connected yet; the only user is the person testing it.

Built from `examples/00_minimal` of `shutter-network/concorde` at commit `e3f746e`, with:

- `telegram-channel/`, a Channel for the Telegram Bot API, written against the Messenger's
  Channel contract and modelled on the framework's Nostr Channel. It replaces the HTTP Channel.
  Meant to move into Concorde as `@shutter-network/concorde/telegram-channel` once it has run.
- `main.ts` passes no model credential to the agent container, mounts `models.json` into it,
  and attaches the tester's chat to the seeded user at boot.
- a `litellm` service holds the model credentials and adds them on the way out, so the agent
  holds none. See [The model proxy](#the-model-proxy).
- `settings.json` and `models.json` choose the model and point pi at the proxy. Both are per
  machine, copied from their `.example` files and never committed.
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

No model credential reaches the agent. A `litellm` service holds the keys and adds the right one
on the way out, so an agent that reads its own environment finds nothing worth having. The
gateway holds none either.

Three files do the work:

| file | role | in git? |
|---|---|---|
| `litellm-config.yaml` | any `claude-*` model goes to Anthropic, everything else goes to `LOCAL_API_BASE` | yes |
| `models.json` | points pi at the proxy instead of the provider | no, per machine |
| `.env` | the real keys and the local endpoint, read only by the proxy | no, per machine |

### Two things to keep in mind

**A stale `models.json` keeps working.** If yours still has the old endpoint and the real key,
everything runs normally and the agent holds the key. Nothing warns you. Copy the new
`models.json.example` on every machine, the droplet included.

**`switch-model.sh` does not know which provider an id belongs to.** It rewrites the model id in
`settings.json` and `models.json` and nothing else. Any `claude-*` id goes to Anthropic and any
other id goes to `LOCAL_API_BASE`, so switching between two Claude models or between two local
ones is safe. Switching across providers is what to watch: a local id on a machine with no
`LOCAL_API_KEY` fails at the first Run, not at the switch.

## Before the first run

1. Put the tarball in `vendor/` as above.
2. `cp .env.example .env` and fill in `LOCAL_API_BASE`, `LOCAL_API_KEY`, `USER_PASSWORD`,
   `TG_TOKEN`, `TG_CHAT`. Running Anthropic instead? Fill in `ANTHROPIC_API_KEY` and leave the
   two `LOCAL_` ones blank.
3. `cp models.json.example models.json` and `cp settings.json.example settings.json`, then put
   your model id in both. The endpoint and the key now live in `.env` and are read by the proxy,
   not by the agent, so `models.json` carries a placeholder key and never a real one.
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
  endpoint directly with a one-word chat completion before debugging anything here. Set
  `BASE_URL` and `API_KEY` from `.env` (`LOCAL_API_BASE`, `LOCAL_API_KEY`) and `MODEL` from
  `settings.json`. This goes straight to the provider and skips the proxy, which is what you
  want when deciding whether the provider itself is up:

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
| `litellm-config.yaml` | which model name goes to which provider |
| `AGENTS.md` | the agent's instructions, mounted read-only |
| `settings.json`, `models.json` | pi's model configuration, mounted read-only |
| `schema.ts`, `drizzle.config.ts` | tables the deployment applies with drizzle-kit |
