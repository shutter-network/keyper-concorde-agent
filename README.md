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
5. Keep group privacy **on** in BotFather. The bot is then woken only by a slash command
   or a reply to one of its own messages, rather than by every message in every room.
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

A room is one user. A **keyper room** covers a set of keypers and holds the operators who run them,
and all of them answer for every keyper the room covers. Only they write
there; teammates are in it and read. The **teammate chat** covers none, holds
teammates, and any keyper may be asked about. Every reply reaches everyone in the room it is sent to.
A keyper is identified by its **instance and keyperset**.

Two separate things decide the operator. Telegram's posting permission decides who **may** write in
a keyper room; `add-operator` records **which sender id** that human is, so the agent can be told
whether an operator or a teammate wrote. A room whose permissions are wrong, or a teammate made
admin, would be read as the operator. It is a soft boundary like the keyper scope, not a control.

**Private 1:1 chats are not served.** `main.ts` pins the Channel to groups, so a direct message
is answered once with "This agent answers in group chats only, and not in direct messages" and
dropped. It is never told its chat id, because the check runs before the chat is looked up.

A message from a **group** that belongs to no user gets one answer carrying its own chat id and
the sender id of whoever wrote, and nothing is recorded. That is how both ids reach whoever
registers the group. `admin.ts` does the rest, against the database, with or without the gateway
running:

```sh
docker compose run --rm --no-deps gateway node admin.ts list-chats
docker compose run --rm --no-deps gateway node admin.ts add-keyper-chat <name> <chatId> <instance>:<set> ... [--operator <id>[,<id>...]]
docker compose run --rm --no-deps gateway node admin.ts add-keypers <chatId> <instance>:<set> ...
docker compose run --rm --no-deps gateway node admin.ts remove-keypers <chatId>
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
| `add-keyper-chat` | creates a **keyper chat**: a set of keypers, written in only by their operators. `<name>` names those operators. One transaction, so a chat nobody can reach never exists. |
| `add-keypers` | adds any number of keypers to an existing chat and leaves the rest alone. A pair the chat already holds is kept once. |
| `remove-keypers` | clears the chat's whole list. It covers nothing until `add-keypers` runs, so the two go together when changing a group. |
| `add-teammate-chat` | creates a **teammate chat**: no keyper, written in by teammates, any keyper may be asked about. Its own command so the kind is typed rather than arrived at by omitting an argument. |
| `list-members` | everyone who has written to that room: sender id, `@handle` or first name, role, when. Plus any recorded operator who has not written. A reader is invisible: Telegram names a sender only on a message. |
| `add-operator` / `remove-operator` | records which sender id is the operator. Warns if they have never written there, but records them anyway. |
| `attach-chat` | gives an existing user a chat. The only command taking a **user id**, which `list-chats` prints last, because you reach for it exactly when the chat id is wrong or missing |
| `remove-chat` | removes the chat only: the framework removes no user, and the message log stays. Names the kind and name of what it removed, so a mistyped id is visible in the output. |

The keyper is the Grafana `instance` label and **nothing validates it**. A typo registers
cleanly and then answers "no series" forever.

Roles carry no privilege. The agent answers an operator and a teammate identically; the label
exists so it can name who runs the keyper, and so the log carries that afterwards.

**What a question may be about follows the room, not the role.** In a keyper room the agent answers
about that room's keypers only, and a question about another is turned back with the names of the
keypers this room covers. In the teammate chat it answers about whichever keyper the question names,
and asks which one if the question names none. So the same person asking the same question gets an
answer in one room and a redirection in the other. The room decides, not who they are. That scope
is **soft**: it is an instruction in `AGENTS.md` and nothing more.

### One chat per operator, and moving it

A room belongs to one set of operators and covers every keyper they run, so a keyper is reached in
exactly one place. Concretely: an `(instance, set)` pair has exactly **one** chat, and the add
commands **refuse** a second. Two rooms holding one pair means two places its operators are written
to and two places they answer from, with nothing to say which one is the keyper's.

Adding a keyper to an operator who already has a room is `add-keypers` on that room, not a second
room. A second room would split their keypers across two places, and a round would then wait on
both.

**To move a whole room to a different chat, do not register it again.** `add-keyper-chat` creates a
*new* user, stranding the old one's message log, its recorded operators and its history. Move it
instead:

```sh
admin.ts list-chats                     # note the user id, last column
admin.ts remove-chat <oldChatId>
admin.ts attach-chat <userId> <newChatId>
```

The user, its keypers, its operators and its whole log come with it.

This is also the recovery when **Telegram changes a group's id** on upgrading a basic group to a
supergroup: the cause differs, the fix does not.

## Coordination

The teammate chat can set two things in motion across every keyper room. A keyper room cannot ask
for either; the agent turns it back.

**Announcements.** One message to each keyper's own room, and nothing is waited for. The teammate
chat supplies the text; the agent writes it to every keyper room and reports which sends succeeded.

**Rounds.** Ask every operator of a keyperset for a time window. The agent asks each room, collects
the replies as they come, and reports to the teammate chat once all of them are in. If the windows
do not all overlap it says so and asks what to do; it never picks a time itself.

Both are driven entirely by `AGENTS.md`. The agent uses `GET /users/` to find the rooms,
`POST /messages/` to write, and keeps round state in a file at `/workspace/coordination.json`.

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