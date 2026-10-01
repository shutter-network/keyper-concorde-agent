// What the agent is told about one inbound Message.
//
// Nothing here names a person. The agent is told only whether an operator or a teammate wrote, never
// a username or an id. Its answer is attached to the question, and that is what shows the room who
// is being answered. A handle typed into the message text still reaches the model.
//
// Separate from main.ts because importing main.ts starts a Gateway, so a test cannot reach it.
// Nothing here touches the database. The Handler reads, and passes the results in.

import type { MessageRecord } from "@shutter-network/concorde/messenger";
import type { TelegramSender } from "./telegram-channel/index.ts";

// A keyper chat covers one keyper, and Telegram's posting permission lets only its operator write
// there. A teammate chat covers none and holds teammates.
export type GroupKind = "keyper" | "teammate";

// What `admin.ts` writes onto a User. `operators` holds the sender ids that count as the operator.
// A teammate chat has none, so everyone who writes there is a teammate.
export type GroupAttributes = {
  readonly kind: GroupKind;
  readonly name?: string;
  readonly keyper?: string;
  readonly operators?: readonly string[];
};

export type PromptData = {
  readonly userId: string;
  readonly text: string;
  readonly keyper: string | null;
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
  constructor(userId: string) {
    super(
      `User ${userId} is a keyper chat with no keyper in their Attributes, so there is nothing to answer about; run admin.ts add-keyper-chat for that chat, or set it by hand`,
    );
    this.name = "UnboundGroupError";
  }
}

// Everyone who is not a recorded operator is a teammate. Telegram already stops a teammate writing
// in a keyper chat, so this list does not decide who may speak. It only names which human the
// operator is. An operator nobody has recorded yet reads as a teammate until `add-operator` runs.
export function roleOf(
  sender: TelegramSender | undefined,
  operators: readonly string[],
): string | null {
  if (sender === undefined || sender.senderId === null) return null;
  return operators.includes(sender.senderId) ? "the operator" : "a teammate";
}

// Attributes come out of the framework as `unknown`, and a row may have been edited by hand, so this
// checks rather than casts. A stray `keyper` on a teammate chat is ignored, not refused: `admin.ts`
// never creates one, and refusing would break a chat that works.
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
): PromptData {
  const group = groupAttributes(message.userId, attributes);
  // Through `String`, because the row may have been edited by hand. A sender id written as a number
  // would match nothing, and would quietly demote the operator to a teammate.
  const operators = Array.isArray(group.operators) ? group.operators.map(String) : [];
  return {
    userId: message.userId,
    text: message.text,
    keyper: group.kind === "keyper" ? (group.keyper ?? null) : null,
    role: roleOf(sender, operators),
  };
}
