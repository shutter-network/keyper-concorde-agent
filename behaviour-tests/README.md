# Keyper behaviour tests

Tests for DKG scheduling with the real gateway and model, using a fake Telegram API.
Each input message starts one agent run.

## Setup

Place this folder inside the application repository. Its parent directory must contain
`package.json`, `vendor/`, `telegram-channel/`, `schema.ts`, `Dockerfile.agent`,
`AGENTS.md`, `settings.json` and `models.json`. Use the deployment's Concorde package
and model configuration.

Requires Docker Compose 2.17 or newer.

## Run

From this directory. `run.sh` passes the repository's `.env` to compose, so the provider key
in it (`ANTHROPIC_API_KEY` or `LOCAL_API_KEY`, as `settings.json` requires) reaches the agent.
A variable exported in the shell takes precedence over the file.

Run one scenario:

```sh
./run.sh scheduling
```

Run all scenarios:

```sh
./run.sh all
```

The tests use their own database, workspace and model sessions. Run one suite at a time.
Each agent run has a 600-second timeout, configurable with `TURN_TIMEOUT_SECONDS`.

Stop the test services when finished:

```sh
docker compose -f compose.behaviour.yml down
```

## Scenarios

- `scheduling`: both operators accept; the team confirms; all receive the final date and time.
- `missing-details`: asks the team for missing details, then contacts the operators after the team supplies them.
- `ambiguous-reply`: an unclear reply sends a response only to that operator; participant IDs remain in the round file.
- `misspelled-date`: a month typo produces a reply only to the team, or messages to both operators with the intended date and time.
- `silent-operator`: one operator replies; participant IDs remain in the round file; the team receives no message.
- `date-detour`: a replacement date goes to the other operator before the team confirms; the out-of-range date never reaches that operator.
- `confidentiality`: private text stays out of messages to the other operator.
- `restart`: scheduling continues after the gateway restarts between replies.

## Checks

`scenarios.test.mts` defines the scenarios and assertions:

- `assertRecipients`: required recipients get a message; other recipients are limited to the optional list.
- `assertDateAndTime`: messages contain the expected date and time. Accepts ISO dates, English month names, DD.MM dates, and 24-hour or AM/PM times.
- `assertQuestionAbout`: a message contains a question mark and matches the topic pattern.
- `assertRoundHasParticipants`: `coordination.json` contains both participant IDs.
- `assertRoundRemoved` and `assertNoRound`: the file is absent or contains neither participant ID.
- `assertNeverSentTo`: messages to a recipient do not contain the specified private text.

A failed agent run fails the scenario. The round file is parsed as JSON, with no required schema.
A pass means these assertions passed. Review the full replies in `report.json` to assess their meaning.

`harness.mts` starts the gateway, sends messages through fake Telegram, waits for each agent
run to finish, and records replies and saved state. Its message template must match `main.ts`.
It copies `AGENTS.md` and sets the `Team user:` line to the scenario's team ID.

## Results

`results/<run>/transcript.txt` shows pass/fail results and shortened messages.
It is printed at the end of the run. Full messages are saved in `report.json`.

A failed scenario includes the failed check.

Each `results/<run>/<scenario>/` directory contains:

- `report.json`: input messages, replies in full, saved state after each run, and result.
- `gateway.log`: gateway logs.
- `workspace/`: files written by the agent.
- `agent/sessions/`: model sessions.

`results/` is ignored by Git.
