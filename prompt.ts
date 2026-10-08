// Build the information passed to the agent for an incoming Message.
//
// Include the sender's role (operator or teammate), but not their username or sender ID.
// Usernames typed into the message text still reach the model.
//
// Keep this module separate so tests can import it without starting the Gateway in main.ts.
// The Handler reads the database and passes the results here; this module does no database work.

import type { MessageRecord } from "@shutter-network/concorde/messenger";
import type { TelegramSender } from "./telegram-channel/index.ts";

// A keyper chat covers a set of keypers, and Telegram permissions allow only the operators who run
// them to post. There may be several, and each answers for every keyper the chat covers.
// A teammate chat is for teammates and covers none.
export type GroupKind = "keyper" | "teammate";

// The keypersets being managed. `admin.ts` refuses anything else, so this is also the list the
// agent can rely on when the team names a set.
export const keyperSets = ["api", "gnosis"] as const;
export type KeyperSet = (typeof keyperSets)[number];

/**
 * One machine taking part in one keyperset, the pair the metrics and logs use. A machine in two
 * keypersets appears twice, because its uptime and running version differ per set even though it
 * is one node.
 */
export type KeyperRef = { readonly instance: string; readonly set: KeyperSet };

// User attributes saved by `admin.ts`. The `operators` list contains operator sender IDs.
// Teammate chats have no operators, so their senders are labeled as teammates.
export type GroupAttributes = {
  readonly kind: GroupKind;
  readonly name?: string;
  readonly keypers?: readonly KeyperRef[];
  readonly operators?: readonly string[];
};

export type PromptData = {
  readonly userId: string;
  readonly text: string;
  readonly keypers: readonly KeyperRef[];
  // The same list written for the prompt. Kept apart from `keypers` so the stored shape and the
  // wording the model reads can change independently.
  readonly covers: string | null;
  readonly role: string | null;
};

export class UnknownGroupKindError extends Error {
  constructor(userId: string, kind: unknown) {
    super(
      `User ${userId} has kind ${JSON.stringify(kind)} in their Attributes; one of keyper or teammate is wanted, and a chat whose kind is unreadable is not answered for`,
    );
    this.name = "UnknownGroupKindError";
  }
}

export class UnboundGroupError extends Error {
  constructor(userId: string, detail = "no keypers") {
    super(
      `User ${userId} is a keyper chat with ${detail} in their Attributes, so there is nothing to answer about; run admin.ts add-keypers for that chat`,
    );
    this.name = "UnboundGroupError";
  }
}

const isKeyperSet = (value: unknown): value is KeyperSet =>
  (keyperSets as readonly unknown[]).includes(value);

/**
 * The group's keypers, written for the model: one clause per machine, so a machine in two
 * keypersets reads as one node rather than two. "keyper kpr-jstcz (api and gnosis keypersets)".
 */
export function describeCoverage(keypers: readonly KeyperRef[]): string | null {
  if (keypers.length === 0) return null;
  const sets = new Map<string, KeyperSet[]>();
  for (const { instance, set } of keypers) {
    sets.set(instance, [...(sets.get(instance) ?? []), set]);
  }
  const machines = [...sets].map(([instance, its]) => {
    const named = its.length === 1 ? `${its[0]} keyperset` : `${its.join(" and ")} keypersets`;
    return `${instance} (${named})`;
  });
  return `${sets.size === 1 ? "keyper" : "keypers"} ${machines.join(", ")}`;
}

// Label senders who are not registered operators as teammates. Telegram permissions control
// who can post in a keyper chat; this list only identifies their role for the agent.
// An operator is labeled as a teammate until `add-operator` records their sender ID.
export function roleOf(
  sender: TelegramSender | undefined,
  operators: readonly string[],
): string | null {
  if (sender === undefined || sender.senderId === null) return null;
  return operators.includes(sender.senderId) ? "the operator" : "a teammate";
}

// Validate the required attributes because the framework returns `unknown` and database rows
// may have been edited manually. Ignore an extra `keypers` field on a teammate chat.
// `admin.ts` never adds that field, but its presence should not stop a valid chat from working.
//
// A malformed entry fails the whole group rather than being skipped. Skipping it would quietly
// narrow what the agent answers about, which reads as a working group that has lost a keyper.
export function groupAttributes(userId: string, attributes: unknown): GroupAttributes {
  const shape = attributes as GroupAttributes | null;
  const kind = shape?.kind;
  if (kind !== "keyper" && kind !== "teammate") throw new UnknownGroupKindError(userId, kind);
  if (kind === "keyper") {
    const keypers = shape?.keypers;
    if (!Array.isArray(keypers) || keypers.length === 0) throw new UnboundGroupError(userId);
    for (const keyper of keypers) {
      if (typeof keyper?.instance !== "string" || keyper.instance === "" || !isKeyperSet(keyper?.set)) {
        throw new UnboundGroupError(userId, `the unreadable keyper ${JSON.stringify(keyper)}`);
      }
    }
  }
  return shape as GroupAttributes;
}

export function promptData(
  message: MessageRecord,
  sender: TelegramSender | undefined,
  attributes: unknown,
): PromptData {
  const group = groupAttributes(message.userId, attributes);
  // Convert IDs to strings in case someone stored them as numbers during a manual database edit.
  // Otherwise, the comparison would fail and the operator would be labeled as a teammate.
  const operators = Array.isArray(group.operators) ? group.operators.map(String) : [];
  const keypers = group.kind === "keyper" ? (group.keypers ?? []) : [];
  return {
    userId: message.userId,
    text: message.text,
    keypers,
    covers: describeCoverage(keypers),
    role: roleOf(sender, operators),
  };
}
