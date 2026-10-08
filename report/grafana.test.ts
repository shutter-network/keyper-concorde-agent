import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { key } from "./evaluate.ts";
import { collect, deploymentSet, readFrames, type PanelFetch } from "./grafana.ts";

/** A Grafana frame shaped the way the public dashboard answers. */
function frame(labels: Record<string, string> | undefined, value: number) {
  return {
    schema: {
      fields: [
        { name: "Time", type: "time" },
        ...(labels === undefined ? [{ name: "Value", type: "number" }] : [{ name: "Value", type: "number", labels }]),
      ],
    },
    data: { values: [[1_790_000_000_000, 1_790_000_060_000], [1, value]] },
  };
}

const body = (...frames: unknown[]) => ({ results: { A: { frames } } });

describe("reading a panel response", () => {
  it("takes the last value of each labelled column", () => {
    const series = readFrames(body(frame({ instance: "kpr-a" }, 99.5)));
    assert.deepEqual(series, [{ labels: { instance: "kpr-a" }, value: 99.5 }]);
  });

  // The Time field is the x axis and carries no keyper, so it must never become a reading.
  it("skips the Time field", () => {
    const series = readFrames(body(frame({ instance: "kpr-a" }, 1)));
    assert.equal(series.length, 1);
    assert.equal(series[0].labels.instance, "kpr-a");
  });

  // A field with no labels identifies no instance, so there is nothing to attribute it to.
  it("skips a field that carries no labels", () => {
    assert.deepEqual(readFrames(body(frame(undefined, 7))), []);
  });

  it("reads every frame in the response", () => {
    const series = readFrames(body(frame({ instance: "kpr-a" }, 1), frame({ instance: "kpr-b" }, 0)));
    assert.deepEqual(series.map((s) => s.labels.instance), ["kpr-a", "kpr-b"]);
  });

  it("answers with nothing for an empty or unexpected body", () => {
    assert.deepEqual(readFrames({}), []);
    assert.deepEqual(readFrames(null), []);
    assert.deepEqual(readFrames({ results: { A: {} } }), []);
  });
});

describe("deciding which set a deployment label belongs to", () => {
  it("reads the prefix", () => {
    assert.equal(deploymentSet("shutter-api-gnosis-1002-set1.1.2"), "api");
    assert.equal(deploymentSet("shutter-gnosis-1000-set1.4.1"), "gnosis");
  });

  it("belongs to neither set when the prefix is something else", () => {
    assert.equal(deploymentSet("shutter-chiado-102000-set1.4.1"), null);
    assert.equal(deploymentSet(undefined), null);
  });
});

/** Answers each panel from a fixed table, and throws for any panel named in `failing`. */
function fakeDashboard(
  byPanel: Record<number, unknown>,
  failing: number[] = [],
): PanelFetch {
  return async (panel) => {
    if (failing.includes(panel)) throw new Error("upstream said 503");
    return byPanel[panel] ?? body();
  };
}

describe("collecting the whole dashboard", () => {
  it("keys uptime by instance and set, taking the set from the panel", async () => {
    const { facts } = await collect(
      fakeDashboard({
        1: body(frame({ instance: "kpr-both" }, 100)),
        2: body(frame({ instance: "kpr-both" }, 99.98)),
      }),
    );
    assert.equal(facts.uptime7[key("kpr-both", "api")], 100);
    assert.equal(facts.uptime7[key("kpr-both", "gnosis")], 99.98);
  });

  it("keys online and last seen by instance alone", async () => {
    const { facts } = await collect(
      fakeDashboard({
        5: body(frame({ instance: "kpr-a" }, 1)),
        9: body(frame({ instance: "kpr-a" }, 1_790_000_060_000)),
      }),
    );
    assert.equal(facts.online["kpr-a"], 1);
    assert.equal(facts.lastSeen["kpr-a"], 1_790_000_060_000);
  });

  it("takes the set for sync and version from the deployment label", async () => {
    const { facts } = await collect(
      fakeDashboard({
        6: body(frame({ instance: "kpr-a", deployment: "shutter-gnosis-1000-set1.4.1" }, 0)),
        7: body(
          frame(
            {
              instance: "kpr-a",
              deployment: "shutter-api-gnosis-1002-set1.1.2",
              deployment_type: "dappnode",
              version: "v1.4.4",
            },
            1,
          ),
        ),
      }),
    );
    assert.equal(facts.sync[key("kpr-a", "gnosis")], 0);
    assert.deepEqual(facts.version[key("kpr-a", "api")], {
      version: "v1.4.4",
      deployment: "shutter-api-gnosis-1002-set1.1.2",
      deploymentType: "dappnode",
    });
  });

  it("drops a series whose deployment label belongs to neither set", async () => {
    const { facts } = await collect(
      fakeDashboard({ 6: body(frame({ instance: "kpr-c", deployment: "shutter-chiado-102000-set1.4.1" }, 0)) }),
    );
    assert.deepEqual(facts.sync, {});
  });

  it("fills a missing version label with a question mark rather than dropping the reading", async () => {
    const { facts } = await collect(
      fakeDashboard({ 7: body(frame({ instance: "kpr-a", deployment: "shutter-api-x" }, 1)) }),
    );
    assert.equal(facts.version[key("kpr-a", "api")].version, "?");
    assert.equal(facts.version[key("kpr-a", "api")].deploymentType, "?");
  });

  // A keyper can report more than one series for sync and last seen, so the highest value wins.
  it("keeps the highest value when a keyper reports twice for sync and last seen", async () => {
    const { facts } = await collect(
      fakeDashboard({
        6: body(
          frame({ instance: "kpr-a", deployment: "shutter-api-x" }, 0),
          frame({ instance: "kpr-a", deployment: "shutter-api-x" }, 1),
        ),
        9: body(frame({ instance: "kpr-a" }, 100), frame({ instance: "kpr-a" }, 400)),
      }),
    );
    assert.equal(facts.sync[key("kpr-a", "api")], 1);
    assert.equal(facts.lastSeen["kpr-a"], 400);
  });

  it("names every instance any panel mentioned, which is the fleet", async () => {
    const { instances } = await collect(
      fakeDashboard({
        1: body(frame({ instance: "kpr-a" }, 100)),
        5: body(frame({ instance: "kpr-b" }, 1)),
      }),
    );
    assert.deepEqual([...instances].sort(), ["kpr-a", "kpr-b"]);
  });

  it("records which sets each instance appeared in", async () => {
    const { setsOf } = await collect(
      fakeDashboard({
        1: body(frame({ instance: "kpr-both" }, 100)),
        2: body(frame({ instance: "kpr-both" }, 99)),
        5: body(frame({ instance: "kpr-api-only" }, 1)),
      }),
    );
    assert.deepEqual([...(setsOf.get("kpr-both") ?? [])].sort(), ["api", "gnosis"]);
    assert.equal(setsOf.get("kpr-api-only"), undefined);
  });

  // A partial report still reaches the team. One that refused to build would tell them nothing.
  it("records a failed panel and carries on with the rest", async () => {
    const { facts, errors } = await collect(
      fakeDashboard({ 5: body(frame({ instance: "kpr-a" }, 1)) }, [1]),
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^uptime7_api: upstream said 503$/);
    assert.equal(facts.online["kpr-a"], 1);
    assert.deepEqual(facts.uptime7, {});
  });
});
