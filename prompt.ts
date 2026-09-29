// What the agent is told about one inbound Message, assembled from the Message and the group's own
// Attributes.
//
// Nothing here names a person. A chat holds several, and the agent is told only whether an operator
// or a teammate wrote -- no username, first name or id. Its answer is attached to the question
// instead, which is what tells the room who is being answered. A handle written into the message
// text still reaches the model, and nothing here can prevent that.
//
// Pure, and separate from main.ts because main.ts starts a Gateway as it is imported and so cannot
// be reached by a test. Nothing here touches the database: the Handler reads, and passes the
// results in.

import type { MessageRecord } from "@shutter-network/concorde/messenger";
import type { TelegramSender } from "./telegram-channel/index.ts";

// A keyper chat covers one keyper and, by Telegram's own posting permission, only its operator
// writes in it; a teammate chat covers none and holds teammates.
export type GroupKind = "keyper" | "teammate";

// What `admin.ts` writes onto a User. `operators` holds the sender ids that count as the operator of
// a keyper chat; a teammate chat has none, so everyone who writes there is a teammate.
export type GroupAttributes = {
  readonly kind: GroupKind;
  readonly name?: string;
  readonly keyper?: string;
  readonly operators?: readonly string[];
};

// An open round this chat has been asked in and owes an answer to.
export type OpenRound = { readonly id: string; readonly keyperset: string };

export type PromptData = {
  readonly userId: string;
  readonly text: string;
  readonly keyper: string | null;
  readonly role: string | null;
  readonly openRound: OpenRound | null;
  /** Today, UTC. Scheduling needs a calendar, and a model without one invents dates. */
  readonly today: string;
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
  constructor(userId: string) {
    super(
      `User ${userId} is a keyper chat with no keyper in their Attributes, so there is nothing to answer about; run admin.ts add-keyper-chat for that chat, or set it by hand`,
    );
    this.name = "UnboundGroupError";
  }
}

// Everyone who is not a recorded operator is a teammate. Telegram already stops a teammate writing
// in a keyper chat, so the list is what names *which* human the operator is rather than what decides
// whether they may speak -- and an operator who has not been recorded yet reads as a teammate until
// `admin.ts add-operator` says otherwise.
export function roleOf(
  sender: TelegramSender | undefined,
  operators: readonly string[],
): string | null {
  if (sender === undefined || sender.senderId === null) return null;
  return operators.includes(sender.senderId) ? "the operator" : "a teammate";
}

// Attributes are `unknown` on the way out of the framework, and a hand-edited row is the reason this
// checks rather than casts. A teammate chat carrying a stray `keyper` is ignored rather than
// refused: `admin.ts` will not create one, and refusing here would break a chat that otherwise works.
export function groupAttributes(userId: string, attributes: unknown): GroupAttributes {
  const shape = attributes as GroupAttributes | null;
  const kind = shape?.kind;
  if (kind !== "keyper" && kind !== "teammate") throw new UnknownGroupKindError(userId, kind);
  if (kind === "keyper" && (typeof shape?.keyper !== "string" || shape.keyper === "")) {
    throw new UnboundGroupError(userId);
  }
  return shape as GroupAttributes;
}

export function promptData(
  message: MessageRecord,
  sender: TelegramSender | undefined,
  attributes: unknown,
  openRound?: OpenRound,
  now: Date = new Date(),
): PromptData {
  const group = groupAttributes(message.userId, attributes);
  // Through `String`, because Attributes are JSON somebody may have edited by hand: a sender id
  // written as a number would never match, and would quietly demote the operator to a teammate.
  const operators = Array.isArray(group.operators) ? group.operators.map(String) : [];
  return {
    userId: message.userId,
    text: message.text,
    keyper: group.kind === "keyper" ? (group.keyper ?? null) : null,
    role: roleOf(sender, operators),
    openRound: openRound ?? null,
    today: now.toISOString().slice(0, 10),
  };
}
