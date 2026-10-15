# Keyper Concorde Agent

Concorde prototype for Shutter Keyper coordination, announcements and status checks over
Telegram. Each registered group has a Concorde user ID and its own message log.

Built from `examples/00_minimal` of `shutter-network/concorde` at commit `e3f746e`, with:

- `telegram-channel/` implements the Messenger Channel interface using the Telegram Bot API.
  It replaces the HTTP Channel.
- `main.ts` configures the Gateway, agent runtime and message handler. Register groups with
  `admin.ts`; startup does not create users or attach chats.
- `settings.json` selects the provider and model; `models.json` configures custom endpoints.
  Copy the `.example` files for each deployment. Do not commit the local configuration.
- `AGENTS.md` defines coordination, announcement and Grafana status duties.
- `SYSTEM.md` replaces Pi's built-in system prompt. Pi appends the project instructions.

## The framework dependency

This deployment installs `@shutter-network/concorde` from a local tarball in `vendor/`.
Build the pinned framework version before building the deployment. The tarball is ignored by Git.

```sh
cd path/to/concorde && git checkout e3f746e && npm ci && npm run build && npm pack
mv shutter-network-concorde-0.1.0.tgz path/to/this/repo/vendor/
```

Switching to a published package will require updating the dependency and Dockerfiles.

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

Register a group as described below, then send the bot a message in that group.

## Groups

Each Telegram group maps to one Concorde user. A **keyper group** covers all Keypers run by
its operators, identified by `(instance, set)`, where `set` is `api` or `gnosis`. Configure
Telegram permissions so only those operators can post; team members can remain as observers.
A **teammate group** can ask about any Keyper and request coordination or announcements.
Replies are visible to everyone in the recipient group.

Telegram permissions control who can post. `add-operator` separately registers sender IDs
for the role label passed to the model. The label does not grant API permissions or enforce
access control.

Private chats receive a group-only notice, without registration IDs. Their messages are not stored.
Unregistered groups receive their chat ID and, if available, the sender's ID. Use these IDs to
register the group. `admin.ts` accesses the database directly and does not require a running Gateway:

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
| `list-chats` | Lists chat ID, kind, name, Keypers, operator IDs and user ID. |
| `add-keyper-chat` | Creates the user, Keyper assignments and chat mapping in one transaction. `<name>` identifies the operator group. |
| `add-keypers` | Adds `(instance, set)` pairs without removing existing entries or duplicating them. |
| `remove-keypers` | Clears all Keyper assignments. Run `add-keypers` before using the group again. |
| `add-teammate-chat` | Registers a team group without Keyper assignments. |
| `list-members` | Lists observed senders and registered operators, with available names, roles and last-message times. It cannot list members who have never posted unless registered as operators. |
| `add-operator` / `remove-operator` | Adds or removes a registered operator sender ID. Adding an unseen sender produces a warning. |
| `attach-chat` | Links a chat to an existing user ID from `list-chats`. |
| `remove-chat` | Removes the chat mapping but preserves the user, attributes and message history. |

Instance names are not checked against Grafana. A misspelled name can be registered and will
produce missing-series results.

`AGENTS.md` restricts a keyper group's status requests to its registered Keypers. Team groups
may ask about any Keyper. These scope rules are prompt instructions, not API access controls.

### One chat per operator, and moving it

Keep an operator's Keypers in one group. Registration commands reject `(instance, set)` pairs
already assigned to another group. To add more Keypers, use `add-keypers` on the existing group.

To change the group's Telegram chat ID, preserve its Concorde user ID. Registering a new user
would create a separate message history. Detach the old chat and attach the new one:

```sh
admin.ts list-chats                     # note the user id, last column
admin.ts remove-chat <oldChatId>
admin.ts attach-chat <userId> <newChatId>
```

This preserves the user, Keyper assignments, operator IDs and message history. Use the same
procedure if a Telegram group migration changes its chat ID.

## Coordination

Only a teammate group may request announcements or coordination rounds.

- Announcements: send the team's message once to each matching group and report delivery results.
- Rounds: collect availability, propose a common time for team approval, then notify participants.
  If there is no overlap, ask about alternatives or request a wider date range from the team.

The agent follows `AGENTS.md`, selects recipients through `GET /users/`, sends through
`POST /messages/`, and stores active rounds in `/workspace/coordination.json`.

## Weekly uptime report

The report generator writes a file that the agent reads when the Scheduler wakes it.

**`report-cron` builds the report.** It reads the registered groups from the database, queries
Grafana, and writes `/workspace/reports/<date>T<time>Z.json`. It runs independently of the agent
and Gateway, so report generation does not block the Signal worker.

**The Scheduler wakes the agent.** The agent reads the newest report for today and
posts a summary to the teammate chat. It uses the generated results without recalculating them.

The report includes only **registered** Keypers. Unregistered Keypers have no recipient group or
configured keyperset and are omitted from the report.

Every registered keyper appears in the summary, healthy or not. Only the ones with a problem get a
**draft**: a message written for that operator, numbered, which the team approves before anything is
sent. The problems are: no metrics at all, offline, online but not syncing, running an old release,
and running a keyperset other than the expected one. `report/releases.json` holds the expected
release and keyperset for each set.

The agent sends drafts to operators only after team approval.

### Running report generation and delivery manually

Build a report now.

```sh
docker compose run --rm --no-deps --build report-cron node report/build.ts
```

It prints the file it wrote and a count: groups, keypers, drafts.

To make the agent read it, write in the teammate chat, any message asking for the report will do,
since the duty is in `AGENTS.md`:

```
/please read today's uptime report
```

That is also how to re-run the duty after a failed scheduled attempt. The agent takes the newest
report for today, so building first and then asking runs the whole sequence.

## Tests

`telegram-channel/telegram-channel.test.ts` runs the Channel against a real PostgreSQL and a
fake Bot API on localhost (`fake-bot-api.ts`): recording chats, inbound texts and redelivery,
unknown chats, outbound replies, refusals, transient failures, splitting, a reply queued while
stopped, a 409 from a second poller, stop and start. The helpers in `test-support.ts` mirror
the framework's own.

`report/*.test.ts` covers the report without Grafana or a database: reading panel frames, deciding
which set a deployment label belongs to, each kind of finding and its message, scope coming from the
registrations, grouping the summary by operator, and the report file's name.

Against the stack's database, without starting the gateway:

```sh
docker compose run --rm test
```

Or anywhere with Node 24 and a PostgreSQL to create databases on:

```sh
DATABASE_URL=postgres://user:password@host:5432/postgres npm test
```

For real-model coordination tests with simulated Telegram chats, see
[behaviour-tests/README.md](behaviour-tests/README.md). These tests use a separate database,
workspace and sessions, and incur model API costs.

## Operating notes

- The model is chosen in `settings.json` and described in `models.json`. After changing the
  model, delete `state/agent/sessions/*`: pi sessions pin the model they started with.
  `./switch-model.sh <model-id>` does both in one step.
- A run that fails tells the sender "I could not process your last message" through the
  handler's `post` phase, and nothing more. The reason is in `docker compose logs gateway`, as
  the error on the `Run finished` line, and in the agent container's own log while it runs:
  `docker logs $(docker ps -q --filter ancestor=keyper-concorde-agent:1.2.0)`.
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

  `HTTP 200` confirms the endpoint accepted this request. A timeout or `HTTP 000` means no HTTP
  response was received; check connectivity, the proxy and the model service.
- `docker compose down` keeps the database. `down -v` deletes it, including the user, its chat
  and the whole message log.

## Files

| file | role |
|---|---|
| `main.ts` | Gateway components, agent runtime and message handler |
| `admin.ts` | Group registration, Keyper assignments and operator IDs |
| `prompt.ts` | Validates group attributes and builds message context for the agent |
| `telegram-channel/` | the Telegram Channel: schema, chats, outbox, Bot API, channel |
| `compose.yml` | gateway, migrate, postgres, agent image |
| `AGENTS.md` | the agent's instructions, mounted read-only |
| `SYSTEM.md` | Pi system-prompt override, mounted read-only |
| `behaviour-tests/` | Real-model coordination scenarios and test runner |
| `settings.json`, `models.json` | pi's model configuration, mounted read-only |
| `schema.ts`, `drizzle.config.ts` | tables the deployment applies with drizzle-kit |
| `report/` | the weekly report: Grafana reads, findings, drafts, and the file it writes |
| `report/releases.json` | the release each keyperset should be running |
| `report/crontab` | when `report-cron` builds the report |
