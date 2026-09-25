# Keyper Concorde Agent

Prototype. A Concorde deployment that lets Shutter keyper operators talk to one agent over
Telegram, with every message recorded per user in the gateway. Runs on one droplet. No operator
is connected yet; the only user is the person testing it.

Built from `examples/00_minimal` of `shutter-network/concorde` at commit `e3f746e`, with:

- `telegram-channel/`, a Channel for the Telegram Bot API, written against the Messenger's
  Channel contract and modelled on the framework's Nostr Channel. It replaces the HTTP Channel.
  Meant to move into Concorde as `@shutter-network/concorde/telegram-channel` once it has run.
- `main.ts` forwards whichever provider keys are set instead of requiring the Anthropic one,
  mounts `models.json` into the agent container, and attaches the tester's chat to the seeded
  user at boot.
- `settings.json` and `models.json` point pi at an OpenAI-compatible endpoint of your choice.
  Both are per machine, copied from their `.example` files and never committed.
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

## Before the first run

1. Put the tarball in `vendor/` as above.
2. `cp .env.example .env` and fill in `LOCAL_API_KEY` and `TG_TOKEN`. Neither a chat nor a user is
   configured here: groups are registered with `admin.ts`.
3. `cp models.json.example models.json` and `cp settings.json.example settings.json`, then put
   the endpoint URL and the model id in both. The key stays in `.env`; `models.json` refers to
   it as `$LOCAL_API_KEY`.
4. If another process polls the same bot token, stop it first. Telegram hands each update to
   one poller, and the Channel logs a 409 until the other one is gone.
5. In BotFather, `/setprivacy` → Disable. With privacy on, a bot only receives group messages
   that @mention it or reply to it, and the agent looks dead while working exactly as designed.

## Run

```sh
docker compose up -d --build
docker compose logs -f gateway
```

Nothing is seeded at boot and no chat is attached, so the log stays quiet until a message
arrives. Register a group as below, then write in it and the reply comes back to the group.

## Groups

One Telegram group is one user is one keyper. Everyone in the group — the keyper's operator and
their teammates — asks about that one keyper, and every reply reaches all of them.

**Private 1:1 chats are not served.** `main.ts` pins the Channel to groups, so a direct message
is answered once with "This agent answers in group chats only, and not in direct messages" and
dropped. It is never told its chat id, because the check runs before the chat is looked up.

A message from a **group** that belongs to no user gets one answer carrying its own chat id and
the sender id of whoever wrote, and nothing is recorded. That is how both ids reach whoever
registers the group. `admin.ts` does the rest, against the database, with or without the gateway
running:

```sh
docker compose run --rm --no-deps gateway node admin.ts list
docker compose run --rm --no-deps gateway node admin.ts add <name> <chatId> <keyper> [operatorSenderId]
docker compose run --rm --no-deps gateway node admin.ts members <chatId>
docker compose run --rm --no-deps gateway node admin.ts operator-add <chatId> <senderId>
docker compose run --rm --no-deps gateway node admin.ts operator-remove <chatId> <senderId>
docker compose run --rm --no-deps gateway node admin.ts attach <userId> <chatId>
docker compose run --rm --no-deps gateway node admin.ts detach <chatId>
```

| command | what it does |
|---|---|
| `list` | one line per group: chat id, name, keyper, operators, user id |
| `add` | creates the user, names it, binds its keyper and attaches the chat, in one transaction, so a group nobody can reach never exists. The optional fourth argument is the operator's sender id, which the enrolment reply already gave you. |
| `members` | everyone who has written to that group — sender id, `@handle` or first name, role, when — plus any recorded operator who has not written yet |
| `operator-add` | records a sender id as an operator. Warns if they have never written there, but records them anyway |
| `operator-remove` | drops one |
| `attach` | gives an existing user a chat. The only command taking a **user id**, which `list` prints last, because you reach for it exactly when the chat id is wrong or missing |
| `detach` | removes the chat only: the framework removes no user, and the message log stays |

The keyper is the Grafana `instance` label and **nothing validates it** — a typo registers
cleanly and then answers "no series" forever.

Roles carry no privilege. The agent answers an operator and a teammate identically; the label
exists so it can name who runs the keyper, and so the log carries that afterwards.

Telegram changes a group's id when it upgrades a basic group to a supergroup. Recovery is
`detach`, then `attach <userId>` with the new id — not `add`, which would build a second user and
strand the log, the keyper and the operators on the first.

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
  endpoint directly with a one-word chat completion before debugging anything here, with
  `BASE_URL`, `API_KEY` and `MODEL` set to the values from `models.json` and `settings.json`:

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
| `admin.ts` | registering groups, their keyper and their operators |
| `prompt.ts` | what the agent is told about one Message, assembled and testable |
| `telegram-channel/` | the Telegram Channel: schema, chats, outbox, Bot API, channel |
| `compose.yml` | gateway, migrate, postgres, agent image |
| `AGENTS.md` | the agent's instructions, mounted read-only |
| `settings.json`, `models.json` | pi's model configuration, mounted read-only |
| `schema.ts`, `drizzle.config.ts` | tables the deployment applies with drizzle-kit |