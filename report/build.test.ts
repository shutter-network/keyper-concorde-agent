import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { key, type KeyperSet, type Releases } from "./evaluate.ts";
import type { Collected } from "./grafana.ts";
import type { KeyperGroup } from "./rooms.ts";
import { buildReport, failedReport, reportPath, reportStem, sentLogPath } from "./build.ts";

const releases: Releases = {
  api: {
    "shutter-compose": { version: "v1.4.4", deployment: null, releaseUrl: "https://example.test/api" },
  },
  gnosis: {
    "shutter-compose": { version: "v1.4.0", deployment: null, releaseUrl: "https://example.test/gnosis" },
  },
};

const at = new Date("2026-10-05T13:00:04.511Z");

function collected(over: Partial<Collected> = {}): Collected {
  return {
    facts: { uptime7: {}, online: {}, sync: {}, version: {}, lastSeen: {} },
    errors: [],
    instances: new Set(),
    setsOf: new Map(),
    ...over,
  };
}

/** A registered group: one operator, and the (instance, set) pairs they run. */
const group = (name: string, userId: string, ...pairs: [string, KeyperSet][]): KeyperGroup => ({
  userId,
  name,
  keypers: pairs.map(([instance, set]) => ({ instance, set })),
});

const running = (version: string) => ({ version, deployment: "", deploymentType: "shutter-compose" });

describe("the report file", () => {
  it("is dated, so the agent can find today's", () => {
    const report = buildReport(collected(), releases, [], at);
    assert.equal(report.reportDate, "2026-10-05");
    assert.equal(report.generatedAt, "2026-10-05T13:00:04.511Z");
  });

  // A second report on the same day must not overwrite the first. The agent records what it sent
  // in a log keyed by draft number, and those numbers only mean anything within one report.
  it("is named by date and time, so two reports in a day are two files", () => {
    const morning = buildReport(collected(), releases, [], new Date("2026-10-05T13:00:04.511Z"));
    const evening = buildReport(collected(), releases, [], new Date("2026-10-05T17:42:00.000Z"));
    assert.equal(reportPath("/r", morning.generatedAt), "/r/2026-10-05T13-00-04Z.json");
    assert.equal(reportPath("/r", evening.generatedAt), "/r/2026-10-05T17-42-00Z.json");
    assert.notEqual(reportPath("/r", morning.generatedAt), reportPath("/r", evening.generatedAt));
  });

  // The agent picks the newest report for today, and the names sort chronologically as text.
  it("sorts chronologically by name", () => {
    const names = ["2026-10-05T17-42-00Z", "2026-10-05T13-00-04Z", "2026-10-05T09-15-00Z"];
    assert.deepEqual([...names].sort(), [
      "2026-10-05T09-15-00Z",
      "2026-10-05T13-00-04Z",
      "2026-10-05T17-42-00Z",
    ]);
    assert.equal(reportStem("2026-10-05T09:15:00.000Z"), "2026-10-05T09-15-00Z");
  });

  it("pairs each report with its own sent log, so draft numbers never cross reports", () => {
    assert.equal(sentLogPath("/r", "2026-10-05T13:00:04.511Z"), "/r/2026-10-05T13-00-04Z.sent.jsonl");
  });
});

// The scope is what is registered, not what the dashboard happens to be reporting. A keyper nobody
// has registered has no group to message and no written-down keyperset to judge it against.
describe("scope", () => {
  it("counts the registered groups and the machines they cover", () => {
    const report = buildReport(collected(), releases, [
      group("Operator A", "user-a", ["kpr-a", "api"], ["kpr-a", "gnosis"]),
      group("Operator B", "user-b", ["kpr-b", "api"]),
    ], at);
    assert.equal(report.summary.groupsSeen, 2);
    // kpr-a twice is one machine in two keypersets, not two keypers.
    assert.equal(report.summary.keypersSeen, 2);
  });

  it("ignores a keyper the dashboard reports but nobody registered", () => {
    const report = buildReport(
      collected({
        instances: new Set(["kpr-stranger"]),
        facts: { uptime7: {}, online: { "kpr-stranger": 0 }, sync: {}, version: {}, lastSeen: {} },
      }),
      releases,
      [],
      at,
    );
    assert.deepEqual(report.summary.rows, []);
    assert.deepEqual(report.drafts, []);
  });

  // The whole point of writing the keyperset down: a keyper that is switched off reports nothing to
  // Grafana, and is exactly the one the team needs to hear about.
  it("reports a registered keyper the dashboard knows nothing about", () => {
    const report = buildReport(collected(), releases, [group("Operator A", "user-a", ["kpr-silent", "api"])], at);
    assert.equal(report.drafts.length, 1);
    assert.equal(report.drafts[0].kind, "nodata");
    assert.match(report.drafts[0].text, /have not received any metrics/);
  });
});

describe("the summary", () => {
  it("is grouped by operator, listing the keypers that group covers", () => {
    const report = buildReport(collected(), releases, [
      group("Operator B", "user-b", ["kpr-b", "api"]),
      group("Operator A", "user-a", ["kpr-a1", "api"], ["kpr-a2", "gnosis"]),
    ], at);
    assert.deepEqual(report.summary.rows.map((r) => r.group), ["Operator A", "Operator B"]);
    assert.deepEqual(report.summary.rows[0].keypers.map((k) => k.instance), ["kpr-a1", "kpr-a2"]);
    assert.deepEqual(report.summary.rows[1].keypers.map((k) => k.instance), ["kpr-b"]);
  });

  it("puts one machine in two keypersets under one entry, with a row for each set", () => {
    const report = buildReport(collected(), releases, [
      group("Operator A", "user-a", ["kpr-both", "api"], ["kpr-both", "gnosis"]),
    ], at);
    const [only] = report.summary.rows[0].keypers;
    assert.equal(report.summary.rows[0].keypers.length, 1);
    assert.equal(only.instance, "kpr-both");
    assert.deepEqual(only.rows.map((r) => r.set), ["api", "gnosis"]);
  });

  // Every registered keyper is in the summary; only the ones with a finding earn a draft.
  it("lists a healthy keyper but writes no draft for it", () => {
    const healthy = collected({
      facts: {
        uptime7: { [key("kpr-ok", "api")]: 100 },
        online: { "kpr-ok": 1 },
        sync: { [key("kpr-ok", "api")]: 1 },
        version: { [key("kpr-ok", "api")]: running("v1.4.4") },
        lastSeen: { "kpr-ok": Date.now() },
      },
    });
    const report = buildReport(healthy, releases, [group("Operator A", "user-a", ["kpr-ok", "api"])], at);
    assert.deepEqual(report.drafts, []);
    assert.equal(report.summary.rows.length, 1);
    assert.deepEqual(report.summary.rows[0].keypers[0].rows[0].online, "Yes");
    assert.deepEqual(report.summary.rows[0].keypers[0].rows[0].upToDate, "Yes");
  });
});

describe("drafts", () => {
  const offline = collected({
    facts: { uptime7: {}, online: { "kpr-down": 0 }, sync: {}, version: {}, lastSeen: { "kpr-down": 1 } },
  });

  it("carries the group it would be sent to, and the userId to send it with", () => {
    const report = buildReport(offline, releases, [group("Ops down", "user-1", ["kpr-down", "api"])], at);
    assert.equal(report.drafts.length, 1);
    assert.deepEqual(
      { n: report.drafts[0].n, group: report.drafts[0].group, userId: report.drafts[0].userId },
      { n: 1, group: "Ops down", userId: "user-1" },
    );
    assert.equal(report.drafts[0].kind, "offline");
  });

  it("numbers drafts from one, uniquely, so the team can approve by number", () => {
    const two = collected({
      facts: { uptime7: {}, online: { "kpr-a": 0, "kpr-b": 0 }, sync: {}, version: {}, lastSeen: {} },
    });
    const report = buildReport(two, releases, [
      group("A", "user-a", ["kpr-a", "api"]),
      group("B", "user-b", ["kpr-b", "api"]),
    ], at);
    assert.deepEqual(report.drafts.map((d) => d.n), [1, 2]);
  });

  // One node, one operator, one group, but two sets and so two findings.
  it("sends several drafts to one group when a keyper is in both sets", () => {
    const both = collected({
      facts: {
        uptime7: {},
        online: { "kpr-both": 1 },
        sync: { [key("kpr-both", "api")]: 0, [key("kpr-both", "gnosis")]: 0 },
        version: {},
        lastSeen: {},
      },
    });
    const report = buildReport(both, releases, [
      group("Ops both", "user-both", ["kpr-both", "api"], ["kpr-both", "gnosis"]),
    ], at);
    assert.deepEqual(report.drafts.map((d) => d.set), ["api", "gnosis"]);
    assert.deepEqual([...new Set(report.drafts.map((d) => d.userId))], ["user-both"]);
    assert.deepEqual(report.drafts.map((d) => d.n), [1, 2]);
  });
});

describe("when a panel failed", () => {
  // A partial report still reaches the team, and says which part is missing.
  it("stays ok and carries the error, so the team is told the report is partial", () => {
    const report = buildReport(collected({ errors: ["online: upstream said 503"] }), releases, [], at);
    assert.equal(report.status, "ok");
    assert.deepEqual(report.errors, ["online: upstream said 503"]);
  });
});

describe("when the report could not be built at all", () => {
  it("is written as failed, with the reason and no drafts", () => {
    const report = failedReport(at, new Error("DATABASE_URL is not set"));
    assert.equal(report.status, "failed");
    assert.deepEqual(report.errors, ["DATABASE_URL is not set"]);
    assert.deepEqual(report.drafts, []);
    assert.equal(report.reportDate, "2026-10-05");
  });
});
