// Checks the LiteLLM proxy through the harness, with the fake Anthropic API in this process and a
// dummy key. Run with `./run.sh proxy`, which points LiteLLM at the fake; no model API is called.
//
// The agent container is launched by the production code in gateway.ts. The runner holds the
// dummy key under the provider variable names, so if gateway.ts forwarded them to the agent again,
// the credential check below would fail.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { failureMessage } from "../prompt.ts";
import { type FakeAnthropic, replyText, startFakeAnthropic, toolResultOf } from "./fake-anthropic.mts";
import { type Harness, type HarnessOptions, startHarness } from "./harness.mts";

const providerKey = "dummy-provider-key";
const model = "claude-haiku-4-5";
const options: HarnessOptions = { keypers: 1, settings: "behaviour-tests/proxy-settings.json", models: "models.json.example" };

let fake: FakeAnthropic;

before(async () => {
  for (const name of ["ANTHROPIC_API_KEY", "LOCAL_API_KEY"]) {
    assert.equal(process.env[name], providerKey, `${name} must hold the dummy key so forwarding it would show. Use ./run.sh proxy.`);
  }
  fake = await startFakeAnthropic();
});

after(async () => {
  await fake.stop();
});

proxyTest("proxy-reply", async (harness) => {
  fake.reply(harness.ids.team!);
  const run = await harness.send("team", "hello");

  assert.equal(run.to("team"), replyText);
  assert.equal(fake.requests.length, 2, "expected a tool call and a final answer");
  for (const request of fake.requests) {
    assert.equal(request.headers["x-api-key"], providerKey);
    assert.equal(request.body.model, model);
  }
  const env = toolResultOf(fake.requests[1]!.body) ?? "";
  assert.ok(env.includes("AGENT_SERVER_URL="), "the tool result holds no env output");
  assert.ok(!env.includes(providerKey), "the agent container's environment holds the provider key");
});

proxyTest("proxy-failure", async (harness) => {
  fake.fail();
  const run = await harness.send("team", "hello again", { expectFailure: true });

  assert.ok(fake.requests.length >= 1, "the request never reached the upstream");
  assert.equal(run.to("team"), failureMessage);
});

function proxyTest(name: string, runScenario: (harness: Harness) => Promise<void>): void {
  test(name, async () => {
    fake.requests.length = 0;
    const harness = await startHarness(name, options);
    try {
      await runScenario(harness);
    } catch (failure) {
      await harness.finish(failure);
      throw failure;
    }
    await harness.finish();
  });
}
