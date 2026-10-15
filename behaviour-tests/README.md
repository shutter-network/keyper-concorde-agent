# Keyper behaviour tests

DKG scheduling tests using Concorde, the configured model and a simulated Telegram API.
Each input message starts one agent run. Tests do not contact real Telegram groups, but
they make model API calls and incur costs.

## Setup

Use this directory in the application checkout. The runner builds from the repository's
source files and Concorde tarball in `vendor/`. Agent containers mount the repository's
`AGENTS.md`, `SYSTEM.md`, `settings.json` and `models.json`.

Requires Docker Compose 2.17 or newer.

## Run

Run from this directory. `run.sh` loads the repository's `.env` through Docker Compose.
It forwards `ANTHROPIC_API_KEY` and `LOCAL_API_KEY` when set. Exported shell variables
override values in `.env`.

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
- `weekly-report`: a fixture report with one draft; the team reads it, approves draft 1, it reaches the right room with the file's text, the sent log has one line, and a second approval sends nothing.
- `many-keypers`: `KEYPERS` operator rooms, default 5; all accept but the last, who offers an in-range alternative; it is checked with the others only, proposed when they agree, confirmed to everyone. `KEYPERS=8 ./run.sh many-keypers`.

## Checks

`scenarios.test.mts` defines the scenarios and assertions:

- `assertRecipients`: required recipients get a message; other recipients are limited to the optional list.
- `assertDateAndTime`: messages contain the expected date and time. Accepts ISO dates, English month names, DD.MM dates, and 24-hour or AM/PM times.
- `assertRoundHasParticipants`: `coordination.json` contains both participant IDs.
- `assertRoundRemoved` and `assertNoRound`: the file is absent or contains neither participant ID.
- `assertNeverSentTo`: messages to a recipient do not contain the specified private text.

A failed agent run fails the scenario. State checks parse `coordination.json` but only check
for participant IDs; they do not validate recorded availability or pending questions.
Message checks inspect recipients and date/time text, not whether a reply is a question,
proposal or confirmation. Confidentiality checks detect specific text, not paraphrased disclosures.
Review `report.json` before treating a pass as evidence that the conversation was correct.

Concurrent rounds, unrelated status questions during a round, and cost measurements are not
automated here. The silent-operator test checks one run, not an extended waiting period.

`harness.mts` creates a test Gateway, injects Telegram messages, waits for each run to finish,
and records replies and state. It duplicates the handler setup from `main.ts`; keep both in sync.
It copies `AGENTS.md` unchanged.

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
