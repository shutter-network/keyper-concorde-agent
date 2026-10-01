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

// Do not ignore duplicate rows here. The `received` check already filters repeated updates
// in this transaction. A duplicate sender record indicates a bug and must roll back the Message.
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
