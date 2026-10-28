// Turns the numbers read from Grafana into findings and the messages operators receive. This is the
// only part of the report that decides what an operator is told.
//
// Facts are keyed by instance and set, because one keyper can run in both the api and gnosis sets.
// It then has two uptime figures, two sync states and two expected versions, and can be up to date
// for one set while outdated for the other. The recipient comes from the group that registered the
// pair, in rooms.ts.

/** The keypersets a keyper can belong to. Taken from the `deployment` label prefix. */
export type KeyperSet = "api" | "gnosis";

/** What the version panel reports for one keyper in one set. */
export type VersionFact = {
  readonly version: string;
  readonly deployment: string;
  readonly deploymentType: string;
};

/**
 * Everything read from the dashboard, already keyed.
 *
 * `uptime7`, `sync` and `version` are keyed `instance|set`. `online` and `lastSeen` are keyed by
 * instance alone, because those panels report the node rather than its participation in a set.
 */
export type Facts = {
  readonly uptime7: Readonly<Record<string, number>>;
  readonly online: Readonly<Record<string, number>>;
  readonly sync: Readonly<Record<string, number>>;
  readonly version: Readonly<Record<string, VersionFact>>;
  readonly lastSeen: Readonly<Record<string, number>>;
};

/** One entry of report/releases.json. `deployment` null means do not compare the deployment label. */
export type ExpectedRelease = {
  readonly version: string;
  readonly deployment: string | null;
  readonly releaseUrl: string;
};

/** releases.json, read as `releases[set][deploymentType]`. */
export type Releases = Readonly<Record<string, Readonly<Record<string, ExpectedRelease>>>>;

export type DraftKind = "offline" | "nodata" | "stalled" | "outdated" | "deployment";

export type Finding = {
  readonly instance: string;
  readonly set: KeyperSet;
  readonly kind: DraftKind;
  readonly text: string;
};

/** One keyper in one set, as the team summary shows it. */
export type SetRow = {
  readonly set: KeyperSet;
  readonly online: "Yes" | "No" | "?";
  readonly uptime7: string;
  readonly metrics: "Yes" | "No";
  readonly upToDate: "Yes" | "No" | "?";
};

export const key = (instance: string, set: KeyperSet): string => `${instance}|${set}`;

/**
 * A percentage to two decimal places with trailing zeros removed, or "-" when there is no number.
 *
 * Matches the Google Sheet the team reads today, so a figure looks the same in both.
 */
export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return `${value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}%`;
}

/**
 * An epoch milliseconds timestamp as `yyyy-MM-dd HH:mm UTC`.
 *
 * Zero means the panel reported nothing at all for this keyper. The dashboard only looks back seven
 * days, so the honest answer is that it has not been seen for a long time rather than a date.
 */
export function formatSeen(epochMs: number | null | undefined): string {
  if (!epochMs) return "more than 30 days ago";
  return `${new Date(epochMs).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * The release this keyper should be running, or undefined when releases.json configures none.
 *
 * A set it does not mention, or a deployment type it does not list, produces no upgrade message.
 * Grafana reports what is running and never what should be running, so an unconfigured set cannot
 * be judged. A missing entry costs a reminder nobody sent; a guessed one would tell an operator to
 * install a version that is not current for their set.
 *
 * Each entry also pins the keyperset build its keypers should report, so a keyper on the current
 * version but a different keyperset is told that rather than told to install the version it already
 * runs. One pin per set works only because the scope is external keypers, which all run on
 * `shutter-api-gnosis-1002-set1.1.2` or `shutter-gnosis-1000-set1.4.1`. Other keypersets run
 * alongside them, 1003 being internal and two more chiado, and none of those is registered.
 *
 * Nothing else records that assumption, including the registrations. Register a keyper from another
 * keyperset and every report drafts it a "wrong deployment" message, which is how the disagreement
 * surfaces. If internal keypersets come into scope, key releases.json by deployment instead of by
 * set, so each keyperset carries its own expected version and no pin is needed.
 */
export function expectedFor(
  releases: Releases,
  set: KeyperSet,
  version: VersionFact,
): ExpectedRelease | undefined {
  return releases[set]?.[version.deploymentType];
}

function draft(instance: string, set: KeyperSet, kind: DraftKind, body: string): Finding {
  return { instance, set, kind, text: `${body}\n\nThank you!` };
}

/**
 * Looks at one keyper in one set and returns its summary row and any messages it has earned.
 *
 * The order of the checks matters:
 *
 * - No data at all stops the other checks. The only useful question about a keyper the dashboard
 *   has not heard from is whether it is still running.
 * - Offline and outdated are checked separately, so a keyper that is both earns two messages.
 * - Stalled is checked only when the keyper is not offline, since an offline keyper is not syncing
 *   either and reporting both would be noise.
 */
export function evaluate(
  instance: string,
  set: KeyperSet,
  facts: Facts,
  releases: Releases,
): { readonly row: SetRow; readonly findings: Finding[] } {
  const label = set.toUpperCase();
  const uptime = facts.uptime7[key(instance, set)] ?? null;
  const online = facts.online[instance] ?? null;
  const sync = facts.sync[key(instance, set)] ?? null;
  const version = facts.version[key(instance, set)];
  const seen = formatSeen(facts.lastSeen[instance]);

  const base = {
    set,
    online: online === 1 ? "Yes" : online === 0 ? "No" : "?",
    uptime7: formatPercent(uptime),
    metrics: online !== null ? "Yes" : "No",
  } as const;

  // Nothing from any panel. The keyper may be switched off, renamed or firewalled, and the only
  // useful question is whether it is still meant to be running.
  if (uptime === null && online === null && version === undefined) {
    return {
      row: { ...base, upToDate: "?" },
      findings: [
        draft(
          instance,
          set,
          "nodata",
          `We have not received any metrics from your Keyper ${instance} (${label} set) since ${seen}.\n\n` +
            `Please check whether it is still running and reachable, and let us know its status.`,
        ),
      ],
    };
  }

  const findings: Finding[] = [];

  if (online === 0) {
    findings.push(
      draft(
        instance,
        set,
        "offline",
        `Your Keyper ${instance} (${label} set) has been offline since ${seen}; its 7-day uptime is ${formatPercent(uptime)}.\n\n` +
          `Could you please check the Keyper logs and confirm that your RPC node is online and ` +
          `reachable? Once it is working again, please restart the Keyper and let us know.`,
      ),
    );
  } else if (sync === 0) {
    findings.push(
      draft(
        instance,
        set,
        "stalled",
        `Your Keyper ${instance} (${label} set) is online but has not been syncing new blocks for ` +
          `at least the last hour.\n\n` +
          `Please check that your RPC endpoint is working and let us know once it is syncing again.`,
      ),
    );
  }

  const expected = version === undefined ? undefined : expectedFor(releases, set, version);
  // A "?" version means the panel answered without a version label, so there is nothing to compare.
  const outdated =
    expected !== undefined &&
    version !== undefined &&
    version.version !== "?" &&
    (version.version !== expected.version ||
      (expected.deployment !== null && version.deployment !== expected.deployment));

  if (outdated && version !== undefined && expected !== undefined) {
    // Two different problems share one draft kind, and the message has to say which one it is.
    // A keyper whose version matches but whose deployment label does not is not running old
    // software; it is on a different keyperset build. Telling that operator their current version
    // is out of date names a version equal to the one they already run, which reads as nonsense.
    const behind = version.version !== expected.version;
    const body = behind
      ? `Your Keyper ${instance} (${label} set) is still running ${version.version}. The current ` +
        `release is ${expected.version}:\n\n${expected.releaseUrl}\n\n` +
        `Please complete the update and let us know once it is done, or if you need help.`
      : `Your Keyper ${instance} (${label} set) runs ${version.version}, which is the current ` +
        `release, but reports deployment ${version.deployment} where ${expected.deployment} is ` +
        `expected:\n\n${expected.releaseUrl}\n\n` +
        `Please check which deployment you are running and let us know, or tell us if this is ` +
        `expected for your setup.`;
    findings.push(draft(instance, set, behind ? "outdated" : "deployment", body));
  }

  // "?" where there is no expectation to judge against, which is also what an unconfigured set gets.
  const upToDate = expected === undefined ? "?" : outdated ? "No" : "Yes";
  return { row: { ...base, upToDate }, findings };
}
