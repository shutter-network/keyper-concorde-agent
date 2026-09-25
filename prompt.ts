// What the agent is told about one inbound Message, assembled from the Message, what Telegram said
// about it, and the group's own Attributes.
//
// Pure, and separate from main.ts because main.ts starts a Gateway as it is imported and so cannot
// be reached by a test. Nothing here touches the database: the Handler reads, and passes the
// results in.

import type { MessageRecord } from "@shutter-network/concorde/messenger";
import type { TelegramSender } from "./telegram-channel/index.ts";

// What `admin.ts` writes onto a User. Every group has a keyper; `operators` may be empty until
// somebody is labelled.
export type GroupAttributes = {
  readonly name?: string;
  readonly keyper: string;
  readonly operators?: readonly string[];
};

export type PromptData = {
  readonly userId: string;
  readonly text: string;
  readonly keyper: string;
  readonly role: string | null;
};

export class UnboundGroupError extends Error {
  constructor(userId: string) {
    super(
      `User ${userId} has no keyper in their Attributes, so there is nothing to answer about; run admin.ts add for that chat, or set it by hand`,
    );
    this.name = "UnboundGroupError";
  }
}

// Everyone who is not an operator is a teammate: with two roles and no privilege, the operators are
// the whole of what has to be recorded.
export function roleOf(
  sender: TelegramSender | undefined,
  operators: readonly string[],
): string | null {
  if (sender === undefined || sender.senderId === null) return null;
  return operators.includes(sender.senderId) ? "the operator" : "a teammate";
}

// Attributes are `unknown` on the way out of the framework, and a hand-edited row is the reason
// this checks rather than casts.
export function groupAttributes(userId: string, attributes: unknown): GroupAttributes {
  const shape = attributes as GroupAttributes | null;
  if (shape == null || typeof shape.keyper !== "string" || shape.keyper === "") {
    throw new UnboundGroupError(userId);
  }
  return shape;
}

export function promptData(
  message: MessageRecord,
  sender: TelegramSender | undefined,
  attributes: unknown,
): PromptData {
  const group = groupAttributes(message.userId, attributes);
  // Through `String`, because Attributes are JSON somebody may have edited by hand: a sender id
  // written as a number would never match, and would quietly demote the operator to a teammate.
  const operators = Array.isArray(group.operators) ? group.operators.map(String) : [];
  return {
    userId: message.userId,
    text: message.text,
    keyper: group.keyper,
    role: roleOf(sender, operators),
  };
}
