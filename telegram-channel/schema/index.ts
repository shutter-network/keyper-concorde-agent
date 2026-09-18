import { sql } from "drizzle-orm";
import { bigint, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "@shutter-network/concorde/users/schema";

export const telegramChannelSchema = pgSchema("keyper_telegram_channel");

// One Telegram chat per User and one User per chat. The chat id is Telegram's integer, kept as
// text because nothing here does arithmetic on it and a group id is negative.
export const chats = telegramChannelSchema.table("chats", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id),
  chatId: text("chat_id").notNull().unique("chats_chat_id_unique"),
  recordedAt: timestamp("recorded_at", { withTimezone: true })
    .notNull()
    .default(sql`clock_timestamp()`),
});

// Every update admitted, by Telegram's update_id, so one redelivered after a restart is dropped
// instead of becoming a second Message.
export const received = telegramChannelSchema.table("received", {
  updateId: bigint("update_id", { mode: "number" }).primaryKey(),
  receivedAt: timestamp("received_at", { withTimezone: true })
    .notNull()
    .default(sql`clock_timestamp()`),
});

// Outbound Messages waiting for the Bot API. A row is deleted once Telegram took it, and kept
// with a reason once Telegram refused it for good.
export const outbox = telegramChannelSchema.table("outbox", {
  messageId: uuid("message_id").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  chatId: text("chat_id").notNull(),
  text: text("text").notNull(),
  reason: text("reason"),
  queuedAt: timestamp("queued_at", { withTimezone: true })
    .notNull()
    .default(sql`clock_timestamp()`),
  failedAt: timestamp("failed_at", { withTimezone: true }),
});

export const telegramChannelTables = { chats, received, outbox };
