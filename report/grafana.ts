// Reads the public Shutter dashboard. It needs no credentials, and the API answers one panel per
// request, so each panel is queried separately.
//
// A failed panel does not stop the report: the error is recorded and that panel's facts stay empty.
// A report built from four panels out of six still reaches the team, saying which part is missing,
// where a report that refused to build would tell them nothing.

import type { Facts, KeyperSet, VersionFact } from "./evaluate.ts";
import { key } from "./evaluate.ts";

export const dashboardUrl =
  "https://grafana.metrics.shutter.network/api/public/dashboards/2b52906b091a445989638922fbe69e5e";

/** Which panel answers which question. These numbers are the dashboard's, not ours. */
export const panels = {
  uptime7Api: 1,
  uptime7Gnosis: 2,
  online: 5,
  sync: 6,
  version: 7,
  lastSeen: 9,
} as const;

/** One labelled series and its latest value. */
export type Series = {
  readonly labels: Readonly<Record<string, string>>;
  readonly value: number;
};

/**
 * Pulls the labelled series out of one panel's response.
 *
 * A frame holds its columns in `data.values`, in the same order as `schema.fields` describes them.
 * The field named `Time` is the x axis and a field with no `labels` identifies no keyper, so both
 * are skipped. The last entry of a column is the most recent sample, which is the current value.
 */
export function readFrames(body: unknown): Series[] {
  const series: Series[] = [];
  const results = (body as { results?: Record<string, unknown> })?.results ?? {};
  for (const result of Object.values(results)) {
    const frames = (result as { frames?: unknown[] })?.frames ?? [];
    for (const frame of frames) {
      const fields = (frame as { schema?: { fields?: unknown[] } })?.schema?.fields ?? [];
      const values = (frame as { data?: { values?: unknown[][] } })?.data?.values ?? [];
      fields.forEach((field, index) => {
        const { name, labels } = field as { name?: string; labels?: Record<string, string> };
        if (name === "Time" || labels === undefined) return;
        const column = values[index] ?? [];
        if (column.length === 0) return;
        series.push({ labels, value: Number(column[column.length - 1]) });
      });
    }
  }
  return series;
}

/**
 * Which set a `deployment` label belongs to, or null for neither. The prefix is the whole rule.
 *
 * The label is the only thing saying which keyperset a series is about. A keyper that is down
 * carries no deployment label, which is why the online and last seen panels are keyed by instance.
 */
export function deploymentSet(deployment: string | undefined): KeyperSet | null {
  if (deployment === undefined) return null;
  if (deployment.startsWith("shutter-api-")) return "api";
  if (deployment.startsWith("shutter-gnosis-")) return "gnosis";
  return null;
}

export type PanelFetch = (panel: number) => Promise<unknown>;

/** Asks the dashboard for one panel. The range must sit inside `timeRange` or Grafana refuses it. */
export const fetchPanel =
  (baseUrl: string = dashboardUrl): PanelFetch =>
  async (panel) => {
    const response = await fetch(`${baseUrl}/panels/${panel}/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        timeRange: { from: "now-7d", to: "now", timezone: "utc" },
        intervalMs: 60_000,
        maxDataPoints: 1000,
      }),
    });
    if (!response.ok) throw new Error(`panel ${panel} answered ${response.status}`);
    return response.json();
  };

export type Collected = {
  readonly facts: Facts;
  /** One line per panel that failed. Empty when every panel answered. */
  readonly errors: string[];
  /** Every instance any panel mentioned, which is the fleet as the dashboard sees it. */
  readonly instances: Set<string>;
  /** The sets each instance appeared in, from the uptime panels and the deployment labels. */
  readonly setsOf: Map<string, Set<KeyperSet>>;
};

/**
 * Reads every panel and keys the results as evaluate.ts expects.
 *
 * Uptime has a panel per set, so the set is known without a label. Sync and version share one panel
 * covering both sets, so their set comes from the deployment label, and a series whose label
 * belongs to neither is dropped. Sync and last seen keep the highest value when a keyper reports
 * more than one series.
 */
export async function collect(fetchOne: PanelFetch): Promise<Collected> {
  const uptime7: Record<string, number> = {};
  const online: Record<string, number> = {};
  const sync: Record<string, number> = {};
  const version: Record<string, VersionFact> = {};
  const lastSeen: Record<string, number> = {};
  const errors: string[] = [];
  const instances = new Set<string>();
  const setsOf = new Map<string, Set<KeyperSet>>();

  const noteSet = (instance: string, set: KeyperSet) => {
    const found = setsOf.get(instance) ?? new Set<KeyperSet>();
    found.add(set);
    setsOf.set(instance, found);
  };

  async function read(name: string, panel: number): Promise<Series[]> {
    try {
      const series = readFrames(await fetchOne(panel));
      for (const one of series) if (one.labels.instance) instances.add(one.labels.instance);
      return series;
    } catch (error) {
      errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  for (const [set, panel] of [
    ["api", panels.uptime7Api],
    ["gnosis", panels.uptime7Gnosis],
  ] as const) {
    for (const one of await read(`uptime7_${set}`, panel)) {
      if (!one.labels.instance) continue;
      uptime7[key(one.labels.instance, set)] = one.value;
      noteSet(one.labels.instance, set);
    }
  }

  for (const one of await read("online", panels.online)) {
    if (one.labels.instance) online[one.labels.instance] = one.value;
  }

  for (const one of await read("sync", panels.sync)) {
    const set = deploymentSet(one.labels.deployment);
    if (set === null || !one.labels.instance) continue;
    const k = key(one.labels.instance, set);
    sync[k] = Math.max(sync[k] ?? 0, one.value);
    noteSet(one.labels.instance, set);
  }

  for (const one of await read("version", panels.version)) {
    const set = deploymentSet(one.labels.deployment);
    if (set === null || !one.labels.instance) continue;
    version[key(one.labels.instance, set)] = {
      version: one.labels.version ?? "?",
      deployment: one.labels.deployment ?? "?",
      deploymentType: one.labels.deployment_type ?? "?",
    };
    noteSet(one.labels.instance, set);
  }

  for (const one of await read("lastSeen", panels.lastSeen)) {
    if (!one.labels.instance) continue;
    lastSeen[one.labels.instance] = Math.max(lastSeen[one.labels.instance] ?? 0, one.value);
  }

  return { facts: { uptime7, online, sync, version, lastSeen }, errors, instances, setsOf };
}
