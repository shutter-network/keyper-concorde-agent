# Keyper Concorde Agent

Prototype. A Concorde deployment that lets Shutter keyper operators talk to one agent over
Telegram, with every message recorded per user in the gateway. Runs on one droplet. No operator
is connected yet; the only user is the person testing it.

Built from `examples/00_minimal` of `shutter-network/concorde` at commit `e3f746e`, with:

- `telegram-channel/`, a Channel for the Telegram Bot API, written against the Messenger's
  Channel contract and modelled on the framework's Nostr Channel. It replaces the HTTP Channel.
  Meant to move into Concorde as `@shutter-network/concorde/telegram-channel` once it has run.
- `coordination/`, what a teammate chat can set in motion across every keyper room at once:
  rounds, which ask every operator of a keyperset for a time window and work out the overlap, and
  announcements, which tell each keyper's operators their own number and wait for nothing.
- `main.ts` forwards whichever provider keys are set instead of requiring the Anthropic one,
  and mounts `models.json` into the agent container. Nothing is seeded and no chat is attached at
  boot: every room is registered with `admin.ts`.
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
5. Leave group privacy **on** in BotFather — the default. The bot is then woken only by an
   @mention or a reply to one of its own messages, rather than by every message in every room.
6. In each keyper group, restrict who may post so that only the operator can. That decides who
   *may* write; `add-operator` records *which sender id* they are, so the agent can be told whether
   an operator or a teammate wrote.

## Run

```sh
docker compose up -d --build
docker compose logs -f gateway
```

Nothing is seeded at boot and no chat is attached, so the log stays quiet until a message
arrives. Register a group as below, then write in it and the reply comes back to the group.

## Groups

A room is one user. A **keyper room** covers one keyper and only its operator writes there;
teammates are in it and read. The **teammate chat** covers none, holds teammates, and any keyper may
be asked about. Every reply reaches everyone in the room it is sent to.

Two separate things decide the operator. Telegram's posting permission decides who **may** write in
a keyper room; `add-operator` records **which sender id** that human is, so the agent can be told
whether an operator or a teammate wrote. A room whose permissions are wrong, or a teammate made
admin, would be read as the operator — the same kind of soft boundary as the keyper scope, not a
control.

**Private 1:1 chats are not served.** `main.ts` pins the Channel to groups, so a direct message
is answered once with "This agent answers in group chats only, and not in direct messages" and
dropped. It is never told its chat id, because the check runs before the chat is looked up.

A message from a **group** that belongs to no user gets one answer carrying its own chat id and
the sender id of whoever wrote, and nothing is recorded. That is how both ids reach whoever
registers the group. `admin.ts` does the rest, against the database, with or without the gateway
running:

```sh
docker compose run --rm --no-deps gateway node admin.ts list-chats
docker compose run --rm --no-deps gateway node admin.ts add-keyper-chat <name> <chatId> <keyper> [operatorSenderId]
docker compose run --rm --no-deps gateway node admin.ts add-teammate-chat <name> <chatId>
docker compose run --rm --no-deps gateway node admin.ts list-members <chatId>
docker compose run --rm --no-deps gateway node admin.ts add-operator <chatId> <senderId>
docker compose run --rm --no-deps gateway node admin.ts remove-operator <chatId> <senderId>
docker compose run --rm --no-deps gateway node admin.ts attach-chat <userId> <chatId>
docker compose run --rm --no-deps gateway node admin.ts remove-chat <chatId>
```

| command | what it does |
|---|---|
| `list-chats` | one line per chat: chat id, kind, name, what it covers, operators, user id |
| `add-keyper-chat` | creates a **keyper chat**: one keyper, written in only by its operator. One transaction, so a chat nobody can reach never exists. |
| `add-teammate-chat` | creates a **teammate chat**: no keyper, written in by teammates, any keyper may be asked about. Its own command so the kind is typed rather than arrived at by omitting an argument. |
| `list-members` | everyone who has written to that room — sender id, `@handle` or first name, role, when — plus any recorded operator who has not written. A reader is invisible: Telegram names a sender only on a message. |
| `add-operator` / `remove-operator` | records which sender id is the operator. Warns if they have never written there, but records them anyway. |
| `attach-chat` | gives an existing user a chat. The only command taking a **user id**, which `list-chats` prints last, because you reach for it exactly when the chat id is wrong or missing |
| `remove-chat` | removes the chat only: the framework removes no user, and the message log stays. Names the kind and name of what it removed, so a mistyped id is visible in the output. |

The keyper is the Grafana `instance` label and **nothing validates it** — a typo registers
cleanly and then answers "no series" forever.

Roles carry no privilege. The agent answers an operator and a teammate identically; the label
exists so it can name who runs the keyper, and so the log carries that afterwards.

### One chat per keyper, and moving it

A keyper has exactly **one** chat, and `add-keyper-chat` **refuses** a second. Two chats would both
be written to by every fan-out, and a round would wait for an answer from each — so one dead room
would stop a round ever completing.

**To move a keyper to a different group, do not register it again.** `add-keyper-chat` creates a
*new* user, stranding the old one's message log, its recorded operators and its history. Move it
instead — the refusal prints the two commands with the ids already filled in:

```sh
admin.ts list-chats                     # note the user id, last column
admin.ts remove-chat <oldChatId>
admin.ts attach-chat <userId> <newChatId>
```

The user, its keyper, its operators and its whole log come with it.

This is also the recovery when **Telegram changes a group's id** on upgrading a basic group to a
supergroup: the cause differs, the fix does not.

## Coordination

A keyper room is one operator and one keyper. The **teammate chat** is the only room that can reach
all of them at once, and there are two ways it can:

**Announcements** — `POST /announce`. One message per keyper, each with its own text, so a per-keyper
number reaches the operators it concerns and nobody else. Nothing is waited for and nothing is
recorded beyond the Messages themselves; the message log is already the durable record. Ask in the
teammate chat for the 7-day uptime of a keyperset and each room is told its own figure.

**Rounds** — asking every operator of a keyperset for a time window, and working out whether they
overlap. The split matters: the model composes the question, recognises that a reply is an answer,
and reads a UTC window out of prose. Everything countable is in code — who was asked, who has
answered, whether that is all of them, whether the windows meet, and reporting exactly once. A model
that owned completeness would leave a round hanging or report it twice, and nothing would catch
either.

| route | what it does |
|---|---|
| `POST /rounds` | opens a round and asks every keyper in the set. A keyperset with a round already open opens nothing and sends nothing — a second round would make an operator's reply ambiguous |
| `POST /rounds/:id/answers` | records one operator's window. When it is the last one outstanding, the round completes on its own |
| `POST /rounds/:id/revise` | asks named operators to move. Bounded at **3 attempts**, because every attempt asks somebody who already answered to change their plans |
| `POST /rounds/:id/close` | gives up on a round so its keyperset can be asked again. A person's judgement, never automatic |
| `GET /rounds` | where the open rounds stand: who has answered, who is still owed |

A completed round **reports and closes itself**. Nobody has to say a finished round is finished —
closing is only for one that has gone dead. When the windows do not all meet, the round names the
largest group that can meet and who falls outside it, and asks those operators to move toward it;
after the third attempt it reports what it has rather than asking again.

Which chat asked is taken from the Signal that woke the Run, never from the agent, which rests on the
Signal Worker being globally serial — one Run in flight at a time.

### Addressing the operator

A reply quotes the message it answers, so the room can see who is being answered. Nothing here has a
message to quote: a fan-out and a round's question both arrive unprompted. So each keyper room's
recorded operators are **@mentioned on a line of its own** above the text:

```
@someoperator
Your 7-day uptime is 99.89%.
```

The handle comes from the last message that operator was seen writing. Three things follow from that,
all deliberate:

- **A room with no handle on file is written to exactly as before**, and nobody is told anything about
  it. Under group privacy the bot only sees an @mention or a reply to itself, so an operator recorded
  from the enrollment reply and silent since has no handle at all — that is the ordinary case at
  first, not an edge one.
- **The latest handle wins and an older one is never fallen back to.** Someone whose most recent
  message carried no username is left unaddressed rather than reached for under a handle they have
  given up, which would ping a stranger or nobody.
- **It is plain text, with no `parse_mode`.** Telegram links a bare `@handle` itself. Turning on HTML
  or MarkdownV2 would put every `<`, `&` and `_` the agent writes at risk of being mangled or
  refused, which is far too much to pay for a mention.

The agent does not write handles itself; the addressing is added by the routes.

## Tests

Every test runs against a **real PostgreSQL** — each file creates and drops its own database, and
nothing about the database is mocked. There is no test framework and no assertion library beyond
`node:assert/strict`.

| file | what it covers |
|---|---|
| `telegram-channel/telegram-channel.test.ts` | the Channel against a fake Bot API on localhost (`fake-bot-api.ts`): recording chats, inbound texts and redelivery, unknown chats, outbound replies, refusals, transient failures, splitting, a reply queued while stopped, a 409 from a second poller, stop and start, and resolving a sender's handle |
| `coordination/rounds.test.ts` | opening a round, recording answers, completing, reporting, revising within the bound, closing, fan-out announcements, a keyper whose chat was removed, and the operator addressing |
| `coordination/windows.test.ts` | the window arithmetic: parsing, overlap, and the largest group that can agree |
| `coordination/mentions.test.ts` | resolving handles and the fallback when there are none |
| `prompt.test.ts` | what the agent is told about one Message, including the operator/teammate role |

The helpers in `test-support.ts` mirror the framework's own. Async assertions go through
`waitUntil(description, condition)` rather than a bare sleep, so a timeout says what it was waiting
for.

Against the stack's database, without starting the gateway:

```sh
docker compose run --rm --build test
```

`--build` matters: without it the image keeps whatever source it was last built with, and a change
you have just made is silently not the one under test.

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
| `main.ts` | the deployment: runtime, components, the two handlers and their failure paths |
| `admin.ts` | registering groups, their keyper and their operators |
| `prompt.ts` | what the agent is told about one Message, assembled and testable |
| `telegram-channel/` | the Telegram Channel: schema, chats, outbox, Bot API, channel |
| `coordination/` | rounds, announcements, window arithmetic, and addressing a room's operator |
| `compose.yml` | gateway, migrate, postgres, agent image |
| `AGENTS.md` | the agent's instructions, mounted read-only |
| `settings.json`, `models.json` | pi's model configuration, mounted read-only |
| `schema.ts`, `drizzle.config.ts` | tables the deployment applies with drizzle-kit |