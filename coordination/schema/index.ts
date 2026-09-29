import { sql } from "drizzle-orm";
import { integer, pgSchema, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "@shutter-network/concorde/users/schema";

export const roundsSchema = pgSchema("keyper_rounds");

// One question put to every keyper chat of a keyperset, and the answers it is waiting for.
//
// `askedTelegramMessageId` is kept so the report can quote the question that started it, months of
// operator chatter later. `reportedAt` is stamped the moment the last answer lands, in that same
// transaction, which is what stops a correction arriving afterwards from reporting a second time.
// `closedAt` is a person's judgement that a round is dead; nothing here expires on its own.
export const rounds = roundsSchema.table("rounds", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  askedByUserId: uuid("asked_by_user_id")
    .notNull()
    .references(() => users.id),
  askedTelegramMessageId: text("asked_telegram_message_id"),
  keyperset: text("keyperset").notNull(),
  question: text("question").notNull(),
  // How many times the operators have been asked to revise. Bounded, because an operator who
  // genuinely cannot make it would otherwise be asked forever, and being asked repeatedly to change
  // your availability costs something a status query does not.
  attempts: integer("attempts").notNull().default(0),
  openedAt: timestamp("opened_at", { withTimezone: true })
    .notNull()
    .default(sql`clock_timestamp()`),
  reportedAt: timestamp("reported_at", { withTimezone: true }),
  closedAt: timestamp("closed_at", { withTimezone: true }),
});

// Which chats the question went to. The keyper is kept beside the chat because the report names
// keypers rather than rooms, and a chat may be re-bound to another keyper later.
export const roundAsks = roundsSchema.table(
  "round_asks",
  {
    roundId: uuid("round_id")
      .notNull()
      .references(() => rounds.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    keyper: text("keyper").notNull(),
    askedAt: timestamp("asked_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    // When this chat was last asked to move. Until it answers again its earlier window is stale, so
    // the round is still waiting on it -- otherwise one outlier replying re-opens the whole question
    // while another is still being waited on, and the one who has not replied gets asked twice.
    reviseAskedAt: timestamp("revise_asked_at", { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.roundId, table.userId] })],
);

// One answer per chat per round, so "actually, make that 4-6" corrects rather than duplicates and
// the count of answers stays the thing that decides whether a round is complete.
//
// `said` is the operator's own words, kept beside the interval the model read out of them: the
// report shows both, so a teammate can see what was meant as well as what was recorded.
export const roundAnswers = roundsSchema.table(
  "round_answers",
  {
    roundId: uuid("round_id")
      .notNull()
      .references(() => rounds.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    fromAt: timestamp("from_at", { withTimezone: true }).notNull(),
    toAt: timestamp("to_at", { withTimezone: true }).notNull(),
    said: text("said").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [primaryKey({ columns: [table.roundId, table.userId] })],
);

export const roundsTables = { rounds, roundAsks, roundAnswers };
