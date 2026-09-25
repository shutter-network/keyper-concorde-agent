import { eq } from "drizzle-orm";
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
