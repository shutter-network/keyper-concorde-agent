# Keyper behaviour tests

Coordination and weekly-report tests using Concorde, the configured model and a simulated Telegram API.
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
- `weekly-report`: the team reviews a fixture report and approves draft 1. The agent sends it unchanged to the intended room, records it once, and does not resend it after duplicate approval.
- `many-keypers`: five operator groups by default, with one Keyper per group. All but one accept the preferred time; the last offers an alternative within the allowed range. The agent asks the others about it, directly or after asking the team. Once everyone agrees, it proposes the time and notifies all groups after team confirmation. Set the group count with `KEYPERS=8 ./run.sh many-keypers`.

## Checks

`scenarios.test.mts` defines the scenarios and assertions:

- `assertRecipients`: required recipients get a message; other recipients are limited to the optional list.
- `assertDateAndTime`: messages contain the expected date and time. Accepts ISO dates, English month names, DD.MM dates, and 24-hour or AM/PM times.
- `assertRoundHasParticipants`: `coordination.json` contains every participant ID for the scenario.
- `assertRoundRemoved` and `assertNoRound`: the file is absent or contains none of the scenario's participant IDs.
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

## LiteLLM proxy test

`proxy.test.mts` checks the LiteLLM proxy with a fake Anthropic API and a dummy key. It does not
read `.env` and makes no model API calls. It uses the deployment's LiteLLM image and
`litellm-config.yaml`, and the pi configuration in `proxy/`.

```sh
./run-proxy.sh
```

- A message gets a reply through LiteLLM: the fake model makes the agent post `proxy-ok` to the chat.
- Every request reaching the fake model carries a dummy key, and the agent container's environment.
- A model error makes the Run fail, and the chat receives the failure message.

The test copies the agent runtime and failure handler from `main.ts` and the credential check guards. Keep both in sync.

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
