// Which Telegram group covers which keypers. This decides the report's scope: only registered
// keypers are reported on, because an unregistered one has no group to message and no recorded
// keyperset to judge it against.
//
// A keyper is identified by the pair `(instance, set)`, as in the metrics. One machine in two
// keypersets appears twice, because its uptime and running version differ per set.

import type { Users } from "@shutter-network/concorde/users";
import { keyperSets } from "../prompt.ts";
import type { KeyperSet } from "./evaluate.ts";

/** One machine taking part in one keyperset. */
export type KeyperRef = { readonly instance: string; readonly set: KeyperSet };

export type KeyperGroup = {
  readonly userId: string;
  /** The operators' name, as `admin.ts` recorded it. Shown to the team beside the group's rows. */
  readonly name: string;
  /** Every pair this group covers, in the order it was registered. */
  readonly keypers: readonly KeyperRef[];
};

export type TeammateRoom = {
  readonly userId: string;
  readonly name: string;
};

// `keyperSets` is imported from prompt.ts so the agent's prompt, `admin.ts` validation and this
// check all accept the same set names.
const isKeyperSet = (value: unknown): value is KeyperSet =>
  (keyperSets as readonly unknown[]).includes(value);

/**
 * Every keyper group and the keypers it covers. Read on each report, so a group registered since
 * the last report is included in this one.
 *
 * An entry with a missing instance or an unknown set is skipped rather than failing the report.
 * `admin.ts` cannot write one, but a hand-edited row can, and one bad entry should not cost the
 * team the whole report. A group left with no valid entry is skipped.
 */
export async function keyperGroups(users: Users): Promise<KeyperGroup[]> {
  const groups: KeyperGroup[] = [];
  for (const user of await users.list()) {
    const { kind, name, keypers } = (user.attributes ?? {}) as {
      kind?: string;
      name?: string;
      keypers?: readonly { instance?: unknown; set?: unknown }[];
    };
    if (kind !== "keyper" || !Array.isArray(keypers)) continue;
    const refs = keypers.filter(
      (one): one is KeyperRef =>
        typeof one?.instance === "string" && one.instance !== "" && isKeyperSet(one?.set),
    );
    if (refs.length === 0) continue;
    groups.push({ userId: user.id, name: name ?? "(unnamed)", keypers: refs });
  }
  return groups;
}

/**
 * The teammates' group, where the report is reviewed.
 *
 * Returns the first one found. `admin.ts add-teammate-chat` warns about a second teammate group
 * rather than refusing it, so pick one instead of failing the report.
 */
export async function teammateRoom(users: Users): Promise<TeammateRoom | undefined> {
  for (const user of await users.list()) {
    const { kind, name } = (user.attributes ?? {}) as { kind?: string; name?: string };
    if (kind === "teammate") return { userId: user.id, name: name ?? "(unnamed)" };
  }
  return undefined;
}
