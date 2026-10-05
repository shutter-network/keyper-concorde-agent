// Build the information passed to the agent for an incoming Message.
//
// Include the sender's role (operator or teammate), but not their username or sender ID.
// Usernames typed into the message text still reach the model.
//
// Keep this module separate so tests can import it without starting the Gateway in main.ts.
// The Handler reads the database and passes the results here; this module does no database work.

import type { MessageRecord } from "@shutter-network/concorde/messenger";
import type { TelegramSender } from "./telegram-channel/index.ts";

// A keyper chat is assigned to one keyper, and Telegram permissions allow only its operator
// to post. A teammate chat is for teammates and has no assigned keyper.
export type GroupKind = "keyper" | "teammate";

// User attributes saved by `admin.ts`. The `operators` list contains operator sender IDs.
// Teammate chats have no operators, so their senders are labeled as teammates.
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
// may have been edited manually. Ignore an extra `keyper` field on a teammate chat.
// `admin.ts` never adds that field, but its presence should not stop a valid chat from working.
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
  // Convert IDs to strings in case someone stored them as numbers during a manual database edit.
  // Otherwise, the comparison would fail and the operator would be labeled as a teammate.
  const operators = Array.isArray(group.operators) ? group.operators.map(String) : [];
  return {
    userId: message.userId,
    text: message.text,
    keyper: group.kind === "keyper" ? (group.keyper ?? null) : null,
    role: roleOf(sender, operators),
  };
}
