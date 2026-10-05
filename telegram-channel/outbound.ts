import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Handle } from "@shutter-network/concorde/db";
import { outbox, type telegramChannelTables } from "./schema/index.ts";

type TelegramHandle = Handle<typeof telegramChannelTables>;

// The PostgreSQL NOTIFY channel a queued row rings, so the drain runs right after the commit.
export const outboxChannel = "keyper_telegram_outbox";

export class UnrecordedChatError extends Error {
  constructor(userId: string) {
    super(
      `no Telegram chat is recorded for User ${userId}, so there is nowhere to send this Message; record one first, and nothing was written`,
    );
    this.name = "UnrecordedChatError";
  }
}

export type Queued = {
  readonly messageId: string;
  readonly userId: string;
  readonly chatId: string;
  readonly text: string;
};

export async function queueText<TSchema extends Record<string, unknown>>(
  handle: Handle<TSchema>,
  queued: Queued,
): Promise<void> {
  await handle.insert(outbox).values(queued);
  await handle.execute(sql`select pg_notify(${outboxChannel}, '')`);
}

export type OutboxRow = typeof outbox.$inferSelect;

export async function selectUnsent(handle: TelegramHandle): Promise<OutboxRow[]> {
  return handle
    .select()
    .from(outbox)
    .where(isNull(outbox.reason))
    .orderBy(asc(outbox.queuedAt), asc(outbox.messageId));
}

export async function deleteSent(handle: TelegramHandle, messageId: string): Promise<void> {
  await handle.delete(outbox).where(eq(outbox.messageId, messageId));
}

export async function recordRefusal(
  handle: TelegramHandle,
  messageId: string,
  reason: string,
): Promise<void> {
  await handle
    .update(outbox)
    .set({ reason, failedAt: sql`clock_timestamp()` })
    .where(and(eq(outbox.messageId, messageId), isNull(outbox.reason)));
}
