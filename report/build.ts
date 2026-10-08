// Builds one weekly report and writes it to the shared workspace.
//
// Runs from the report-cron service, separately from the gateway. The Scheduler wakes the agent an
// hour later to read the file. Keeping them apart means a slow or failing report cannot block the
// Signal worker, which runs one Run at a time for the whole deployment.
//
// Scope is the registered keypers, read from `GET /users/` and not from the dashboard. An
// unregistered keyper has no group to message and no recorded keyperset, so it is left out
// entirely. Grafana supplies only the numbers.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openDb } from "@shutter-network/concorde/db";
import { createUsers } from "@shutter-network/concorde/users";
import { evaluate, type KeyperSet, type Releases, type SetRow } from "./evaluate.ts";
import { collect, type Collected, fetchPanel } from "./grafana.ts";
import { keyperGroups, type KeyperGroup } from "./rooms.ts";

/** One machine in the summary, with a row per keyperset it takes part in. */
export type SummaryKeyper = {
  readonly instance: string;
  readonly rows: readonly SetRow[];
};

/** One operator's group in the summary, with the keypers it covers. */
export type SummaryGroup = {
  /** The operators' name, as `admin.ts` recorded it. */
  readonly group: string;
  readonly userId: string;
  readonly keypers: readonly SummaryKeyper[];
};

/** A message waiting for the team to approve it. `n` is what the team approves by. */
export type Draft = {
  readonly n: number;
  readonly instance: string;
  readonly set: KeyperSet;
  readonly kind: string;
  readonly userId: string;
  /** The group it would be sent to, named so the team can see where each draft is going. */
  readonly group: string;
  readonly text: string;
};

export type Report = {
  readonly reportDate: string;
  readonly generatedAt: string;
  readonly status: "ok" | "failed";
  /** One line per panel that failed. A report with errors and status "ok" is partial, not wrong. */
  readonly errors: readonly string[];
  readonly summary: {
    readonly groupsSeen: number;
    readonly keypersSeen: number;
    readonly counts: Readonly<Record<string, number>>;
    readonly rows: readonly SummaryGroup[];
  };
  readonly drafts: readonly Draft[];
};

/**
 * Turns the collected facts into the report the agent reads. Pure, so a test can build a report
 * from fixture facts without Grafana or a database.
 *
 * Draft numbers are assigned in the order groups and their keypers are walked. The team approves by
 * those numbers, and they mean nothing outside this one report.
 *
 * Every registered keyper gets a summary row whether or not anything is wrong; only the ones with a
 * finding get a draft. The team sees the whole fleet, and operators hear from us only when there is
 * something to do.
 */
export function buildReport(
  collected: Collected,
  releases: Releases,
  groups: readonly KeyperGroup[],
  now: Date,
): Report {
  const rows: SummaryGroup[] = [];
  const drafts: Draft[] = [];
  const counts: Record<string, number> = {};
  const instances = new Set<string>();
  let n = 0;

  for (const group of [...groups].sort((a, b) => a.name.localeCompare(b.name))) {
    const byInstance = new Map<string, SetRow[]>();

    for (const { instance, set } of group.keypers) {
      instances.add(instance);
      const { row, findings } = evaluate(instance, set, collected.facts, releases);
      byInstance.set(instance, [...(byInstance.get(instance) ?? []), row]);

      for (const finding of findings) {
        counts[finding.kind] = (counts[finding.kind] ?? 0) + 1;
        n += 1;
        drafts.push({
          n,
          instance,
          set,
          kind: finding.kind,
          userId: group.userId,
          group: group.name,
          text: finding.text,
        });
      }
    }

    rows.push({
      group: group.name,
      userId: group.userId,
      keypers: [...byInstance].map(([instance, sets]) => ({ instance, rows: sets })),
    });
  }

  return {
    reportDate: now.toISOString().slice(0, 10),
    generatedAt: now.toISOString(),
    status: "ok",
    errors: collected.errors,
    summary: { groupsSeen: rows.length, keypersSeen: instances.size, counts, rows },
    drafts,
  };
}

/** A report that could not be built at all, so the agent can tell the team instead of staying quiet. */
export function failedReport(now: Date, error: unknown): Report {
  return {
    reportDate: now.toISOString().slice(0, 10),
    generatedAt: now.toISOString(),
    status: "failed",
    errors: [error instanceof Error ? error.message : String(error)],
    summary: { groupsSeen: 0, keypersSeen: 0, counts: {}, rows: [] },
    drafts: [],
  };
}

/**
 * The file name for one report, from the instant it was generated.
 *
 * Date and time rather than date alone, so a second report on the same day is a new file instead of
 * overwriting the first. The agent records what it sent in a log beside the report, keyed by draft
 * number; overwriting would point those numbers at drafts that no longer exist, and the agent would
 * treat an unsent message as already sent.
 *
 * The names sort oldest to newest as text, which is how the agent picks the newest report for today.
 */
export const reportStem = (generatedAt: string): string =>
  `${generatedAt.slice(0, 19).replace(/:/g, "-")}Z`;

export const reportPath = (dir: string, generatedAt: string): string =>
  join(dir, `${reportStem(generatedAt)}.json`);

/** Where the agent records what it sent for one report. One log per report, never shared. */
export const sentLogPath = (dir: string, generatedAt: string): string =>
  join(dir, `${reportStem(generatedAt)}.sent.jsonl`);

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined) throw new Error("DATABASE_URL is not set");
  const dir = process.env.REPORT_DIR ?? "state/workspace/reports";
  const now = new Date();

  let report: Report;
  try {
    const releases = JSON.parse(
      await readFile(process.env.RELEASES_FILE ?? "report/releases.json", "utf8"),
    ) as Releases;
    const db = openDb(databaseUrl);
    const groups = await keyperGroups(createUsers({ db }));
    report = buildReport(await collect(fetchPanel()), releases, groups, now);
  } catch (error) {
    // Written rather than thrown away: a report that failed is something the team has to be told,
    // and the file is the only way the agent learns it even tried.
    report = failedReport(now, error);
  }

  await mkdir(dir, { recursive: true });
  const path = reportPath(dir, report.generatedAt);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(
    `${path}: status ${report.status}, ${report.summary.groupsSeen} groups, ` +
      `${report.summary.keypersSeen} keypers, ${report.drafts.length} drafts` +
      `${report.errors.length > 0 ? `, ${report.errors.length} panel errors` : ""}`,
  );
  if (report.status === "failed") process.exitCode = 1;
}

// Only when run directly, so a test can import the pure parts without building a report.
if (process.argv[1]?.endsWith("build.ts")) await main();
