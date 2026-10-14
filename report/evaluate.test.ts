import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  evaluate,
  expectedFor,
  formatPercent,
  formatSeen,
  key,
  type Facts,
  type Releases,
} from "./evaluate.ts";

const releases: Releases = {
  api: {
    "shutter-compose": {
      version: "v1.4.4",
      deployment: "shutter-api-gnosis-1002-set1.1.2",
      releaseUrl: "https://example.test/api",
    },
    "no-deployment-check": { version: "v1.4.4", deployment: null, releaseUrl: "https://example.test/x" },
  },
  gnosis: {
    "shutter-compose": {
      version: "v1.4.0",
      deployment: "shutter-gnosis-1000-set1.4.1",
      releaseUrl: "https://example.test/gnosis",
    },
  },
};

const empty: Facts = { uptime7: {}, online: {}, sync: {}, version: {}, lastSeen: {} };

/** Facts for one keyper in one set, so each test states only what it is about. */
function factsFor(
  instance: string,
  set: "api" | "gnosis",
  f: {
    uptime7?: number;
    online?: number;
    sync?: number;
    version?: { version: string; deployment: string; deploymentType: string };
    lastSeen?: number;
  },
): Facts {
  const k = key(instance, set);
  return {
    uptime7: f.uptime7 === undefined ? {} : { [k]: f.uptime7 },
    online: f.online === undefined ? {} : { [instance]: f.online },
    sync: f.sync === undefined ? {} : { [k]: f.sync },
    version: f.version === undefined ? {} : { [k]: f.version },
    lastSeen: f.lastSeen === undefined ? {} : { [instance]: f.lastSeen },
  };
}

const current = {
  version: "v1.4.4",
  deployment: "shutter-api-gnosis-1002-set1.1.2",
  deploymentType: "shutter-compose",
};

describe("formatting", () => {
  it("writes a percentage to two places and drops trailing zeros", () => {
    assert.equal(formatPercent(99.8912), "99.89%");
    assert.equal(formatPercent(100), "100%");
    assert.equal(formatPercent(99.9), "99.9%");
  });

  it("writes a dash where there is no number", () => {
    assert.equal(formatPercent(null), "-");
    assert.equal(formatPercent(undefined), "-");
  });

  it("writes a timestamp in UTC to the minute", () => {
    assert.equal(formatSeen(Date.UTC(2026, 9, 5, 13, 4, 59)), "2026-10-05 13:04 UTC");
  });

  // The dashboard only looks back seven days, so a zero means the keyper was not seen in the window
  // rather than that it was seen at the epoch.
  it("says a keyper was not seen for a long time rather than printing 1970", () => {
    assert.equal(formatSeen(0), "more than 30 days ago");
    assert.equal(formatSeen(undefined), "more than 30 days ago");
  });
});

describe("choosing the expected release", () => {
  it("reads the entry for the set and the deployment type", () => {
    assert.equal(expectedFor(releases, "api", current)?.version, "v1.4.4");
    assert.equal(expectedFor(releases, "gnosis", { ...current, deploymentType: "shutter-compose" })?.version, "v1.4.0");
  });

  // The same node can be correct for one set and behind for the other, which is why the set is part
  // of the lookup and not just the deployment type.
  it("gives a different expectation per set for one deployment type", () => {
    assert.notEqual(
      expectedFor(releases, "api", current)?.version,
      expectedFor(releases, "gnosis", current)?.version,
    );
  });

  it("has no expectation for a deployment type it does not list", () => {
    assert.equal(expectedFor(releases, "api", { ...current, deploymentType: "homegrown" }), undefined);
  });

  it("has no expectation for a set it does not list", () => {
    assert.equal(expectedFor({}, "api", current), undefined);
  });
});

describe("a keyper the dashboard knows nothing about", () => {
  it("asks whether it is still running, and checks nothing else", () => {
    const { row, findings } = evaluate("kpr-ghost", "api", empty, releases);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, "nodata");
    assert.match(findings[0].text, /have not received any metrics from your Keyper kpr-ghost \(API set\)/);
    assert.match(findings[0].text, /more than 30 days ago/);
    assert.deepEqual(row, { set: "api", online: "?", uptime7: "-", metrics: "No", upToDate: "?" });
  });
});

describe("an offline keyper", () => {
  const facts = factsFor("kpr-down", "api", {
    online: 0,
    uptime7: 42.5,
    lastSeen: Date.UTC(2026, 9, 1, 9, 30),
  });

  it("asks the operator to check the logs, naming when it was last seen", () => {
    const { findings } = evaluate("kpr-down", "api", facts, releases);
    assert.deepEqual(findings.map((f) => f.kind), ["offline"]);
    assert.match(findings[0].text, /offline since 2026-10-01 09:30 UTC; its 7-day uptime is 42.5%/);
  });

  it("is reported as offline in the summary", () => {
    const { row } = evaluate("kpr-down", "api", facts, releases);
    assert.equal(row.online, "No");
    assert.equal(row.metrics, "Yes");
  });

  // An offline keyper is not syncing either, so saying both would be noise.
  it("is not also reported as stalled", () => {
    const stalled = { ...facts, sync: { [key("kpr-down", "api")]: 0 } };
    const { findings } = evaluate("kpr-down", "api", stalled, releases);
    assert.deepEqual(findings.map((f) => f.kind), ["offline"]);
  });

  // Being offline says nothing about the version, so both messages are earned.
  it("is also told about an old release when it is behind", () => {
    const behind = {
      ...facts,
      version: { [key("kpr-down", "api")]: { ...current, version: "v1.4.0" } },
    };
    const { findings } = evaluate("kpr-down", "api", behind, releases);
    assert.deepEqual(findings.map((f) => f.kind), ["offline", "outdated"]);
  });
});

describe("a stalled keyper", () => {
  it("is asked to check its RPC endpoint", () => {
    const facts = factsFor("kpr-stuck", "gnosis", { online: 1, sync: 0, uptime7: 99.9 });
    const { findings, row } = evaluate("kpr-stuck", "gnosis", facts, releases);
    assert.deepEqual(findings.map((f) => f.kind), ["stalled"]);
    assert.match(findings[0].text, /\(GNOSIS set\) is online but has not been syncing/);
    assert.equal(row.online, "Yes");
  });
});

describe("an outdated keyper", () => {
  it("is told what it runs, what is current, and where to get it", () => {
    const facts = factsFor("kpr-old", "api", {
      online: 1,
      version: { ...current, version: "v1.4.0" },
    });
    const { findings, row } = evaluate("kpr-old", "api", facts, releases);
    assert.deepEqual(findings.map((f) => f.kind), ["outdated"]);
    assert.match(findings[0].text, /still running v1\.4\.0\. The current release is v1\.4\.4/);
    assert.match(findings[0].text, /https:\/\/example\.test\/api/);
    assert.equal(row.upToDate, "No");
  });

  // Found on the first live run: all five registered rooms were told their current version was out
  // of date, because the deployment label named a different keyperset. The version and the
  // deployment are different problems and the message has to say which one it is.
  it("reports a deployment mismatch as its own kind, not as an old version", () => {
    const facts = factsFor("kpr-set", "api", {
      online: 1,
      version: { ...current, deployment: "shutter-api-gnosis-1003-set0.0.2" },
    });
    const { findings } = evaluate("kpr-set", "api", facts, releases);
    assert.deepEqual(findings.map((f) => f.kind), ["deployment"]);
    assert.match(findings[0].text, /runs v1\.4\.4, which is the current release, but reports deployment/);
    assert.doesNotMatch(findings[0].text, /still running/);
  });

  it("names the version only when the version is the thing that differs", () => {
    const facts = factsFor("kpr-old2", "api", {
      online: 1,
      version: { ...current, version: "v1.4.0" },
    });
    const { findings } = evaluate("kpr-old2", "api", facts, releases);
    assert.deepEqual(findings.map((f) => f.kind), ["outdated"]);
    assert.doesNotMatch(findings[0].text, /reports deployment/);
  });

  it("ignores the deployment label where the entry sets it to null", () => {
    const facts = factsFor("kpr-any", "api", {
      online: 1,
      version: { version: "v1.4.4", deployment: "anything-at-all", deploymentType: "no-deployment-check" },
    });
    const { findings, row } = evaluate("kpr-any", "api", facts, releases);
    assert.deepEqual(findings, []);
    assert.equal(row.upToDate, "Yes");
  });

  it("says nothing when the panel reported no version label", () => {
    const facts = factsFor("kpr-blank", "api", {
      online: 1,
      version: { ...current, version: "?" },
    });
    const { findings } = evaluate("kpr-blank", "api", facts, releases);
    assert.deepEqual(findings, []);
  });
});

// The whole point of making sets opt in: an unconfigured set is one we cannot judge, and a guess
// would tell an operator to install a version that is not current for their set.
describe("a set that releases.json does not mention", () => {
  it("earns no upgrade message and is reported as unknown", () => {
    const facts = factsFor("kpr-new", "gnosis", {
      online: 1,
      version: { ...current, deploymentType: "homegrown" },
    });
    const { findings, row } = evaluate("kpr-new", "gnosis", facts, releases);
    assert.deepEqual(findings, []);
    assert.equal(row.upToDate, "?");
  });

  it("still reports uptime and online status", () => {
    const facts = factsFor("kpr-new", "gnosis", { online: 1, uptime7: 98.5 });
    const { row } = evaluate("kpr-new", "gnosis", facts, releases);
    assert.equal(row.online, "Yes");
    assert.equal(row.uptime7, "98.5%");
  });
});

// One physical node in both sets: two uptime figures, two expectations, two answers.
describe("a keyper in both sets", () => {
  const facts: Facts = {
    uptime7: { [key("kpr-both", "api")]: 100, [key("kpr-both", "gnosis")]: 99.98 },
    online: { "kpr-both": 1 },
    sync: {},
    version: {
      [key("kpr-both", "api")]: current,
      [key("kpr-both", "gnosis")]: { ...current, deployment: "shutter-gnosis-1000-set1.4.1" },
    },
    lastSeen: { "kpr-both": Date.UTC(2026, 9, 5, 12, 0) },
  };

  it("is up to date for api and outdated for gnosis, from the same running version", () => {
    const api = evaluate("kpr-both", "api", facts, releases);
    const gnosis = evaluate("kpr-both", "gnosis", facts, releases);
    assert.deepEqual(api.findings, []);
    assert.equal(api.row.upToDate, "Yes");
    assert.deepEqual(gnosis.findings.map((f) => f.kind), ["outdated"]);
    assert.match(gnosis.findings[0].text, /still running v1\.4\.4\. The current release is v1\.4\.0/);
  });

  it("reports each set's own uptime", () => {
    assert.equal(evaluate("kpr-both", "api", facts, releases).row.uptime7, "100%");
    assert.equal(evaluate("kpr-both", "gnosis", facts, releases).row.uptime7, "99.98%");
  });
});

describe("every message", () => {
  it("ends with the sign-off and carries no greeting", () => {
    const facts = factsFor("kpr-x", "api", { online: 0, lastSeen: 1 });
    const { findings } = evaluate("kpr-x", "api", facts, releases);
    assert.match(findings[0].text, /Thank you!$/);
    assert.doesNotMatch(findings[0].text, /^Hi /);
  });
});
