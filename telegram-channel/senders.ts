import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import type { Handle } from "@shutter-network/concorde/db";
import { senders } from "./schema/index.ts";

export type TelegramSender = {
  readonly senderId: string | null;
  readonly username: string | null;
  readonly firstName: string | null;
  readonly chatId: string;
  readonly chatType: string;
  readonly telegramMessageId: string;
};

// No conflict clause, unlike `received`: that claim already absorbed the redelivery earlier in this
// transaction, so a second row here is an invariant violation and raising rolls the Message back.
export async function insertSender<TSchema extends Record<string, unknown>>(
  handle: Handle<TSchema>,
  messageId: string,
  sender: TelegramSender,
): Promise<void> {
  await handle.insert(senders).values({ messageId, ...sender });
}

export async function selectSenderFor<TSchema extends Record<string, unknown>>(
  handle: Handle<TSchema>,
  messageId: string,
): Promise<TelegramSender | undefined> {
  const [row] = await handle
    .select({
      senderId: senders.senderId,
      username: senders.username,
      firstName: senders.firstName,
      chatId: senders.chatId,
      chatType: senders.chatType,
      telegramMessageId: senders.telegramMessageId,
    })
    .from(senders)
    .where(eq(senders.messageId, messageId))
    .limit(1);
  return row;
}

/**
 * The username last seen for each of these senders, by sender id. A sender with none is absent.
 *
 * A username is a snapshot, not an identity: people change and remove them, and nothing here is
 * notified when they do. So this takes the **latest** row for each sender and nothing older -- a
 * person whose last message carried no username is reported as having none, rather than reached for
 * under a handle they have since given up, which would address a stranger or nobody.
 *
 * Only senders the bot has actually seen write are here at all. Under group privacy it is woken by
 * an @mention or a reply to itself, so a sender recorded by hand and silent ever since has no row.
 */
export async function selectUsernamesFor<TSchema extends Record<string, unknown>>(
  handle: Handle<TSchema>,
  senderIds: readonly string[],
): Promise<Map<string, string>> {
  const wanted = [...new Set(senderIds)];
  if (wanted.length === 0) return new Map();
  const rows = await handle
    .selectDistinctOn([senders.senderId], {
      senderId: senders.senderId,
      username: senders.username,
    })
    .from(senders)
    .where(and(isNotNull(senders.senderId), inArray(senders.senderId, wanted)))
    .orderBy(senders.senderId, desc(senders.recordedAt));
  const found = new Map<string, string>();
  for (const row of rows) {
    if (row.senderId !== null && row.username !== null && row.username !== "") {
      found.set(row.senderId, row.username);
    }
  }
  return found;
}
