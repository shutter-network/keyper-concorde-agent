// Rounds: one question put to every keyper chat of a keyperset, and the answers it waits for.
//
// The split this exists to enforce: the model composes the question, recognises that a message is an
// answer, and reads a UTC window out of prose. Everything countable is here -- who was asked, who has
// answered, whether that is all of them, and reporting once. A model that owned completeness would
// leave a round hanging or report it twice, and nothing would catch either.
//
// Deployment code, not Channel code: "keyperset" and "operator" are words this deployment knows and
// `telegram-channel/` must not.
//
// The PostgreSQL schema stays `keyper_rounds`: rounds are the only thing here with tables, since
// announcing records nothing beyond the Messages themselves.

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@shutter-network/concorde/db";
import type { ServerComponent } from "@shutter-network/concorde/gateway";
import type { Messenger } from "@shutter-network/concorde/messenger";
import type { SignalWorker } from "@shutter-network/concorde/signals";
import type { Users } from "@shutter-network/concorde/users";
import { keyperChatsByKeyper, splitByChat } from "./keyper-chats.ts";
import { addressed } from "./mentions.ts";
import { overlapOf } from "./windows.ts";
import { roundAnswers, roundAsks, rounds, roundsTables } from "./schema/index.ts";
import { MalformedWindowError, parseWindow } from "./windows.ts";

export const roundCompletedKind = "round.completed";

/**
 * How many times the operators may be asked to revise before the round gives up and reports what it
 * has. Every attempt is a message to somebody who already answered once, so the bound is as much
 * about not wearing operators out as about terminating.
 */
export const maxAttempts = 3;

export type RoundCompleted = { readonly roundId: string };

/**
 * Which chat and which of its messages the Run in flight is acting for.
 *
 * The routes read this rather than taking ids from the agent: one Run is ever in flight, so it is
 * unambiguous, and it is two fewer identifiers for a model to get wrong. The same reasoning, and the
 * same dependence on a serial Worker, as the Channel's reply target.
 */
export type RunContext = {
  readonly userId: string;
  readonly telegramMessageId: string | null;
};

export type RoundsOptions = {
  readonly db: Db;
  readonly users: Users;
  readonly messenger: Messenger;
  readonly worker: SignalWorker;
  readonly agentServer: ServerComponent;
  /** Whether a User can be written to at all. A User with no chat is not a keyper's chat. */
  readonly reachable: (userId: string) => Promise<boolean>;
  /**
   * The handle last seen for each of these senders. Injected rather than reached for, because the
   * usernames live in the Channel's own tables and this component must not learn its schema.
   */
  readonly usernamesOf: (senderIds: readonly string[]) => Promise<Map<string, string>>;
};

export function createRounds(options: RoundsOptions) {
  const { db, users, messenger, worker, agentServer, reachable, usernamesOf } = options;
  const handle = db.handle(roundsTables);
  let current: RunContext | undefined;

  // An answer counts only if it came after the last request to move. An operator asked to revise is
  // being waited on even though their earlier window is still on file, which is what stops one
  // outlier replying from re-opening the question while another has not.
  const answeredSinceAsked = sql`${roundAnswers.recordedAt} > coalesce(${roundAsks.reviseAskedAt}, 'epoch'::timestamptz)`;

  // A round is open until it either reports or is given up on. The two endings are kept apart:
  // `reportedAt` means every operator answered and the result went out, `closedAt` means a person
  // judged it dead. Only the second needs anybody to do anything, and conflating them would lose
  // which of the two happened.
  const stillOpen = () => and(isNull(rounds.reportedAt), isNull(rounds.closedAt));

  async function openRoundFor(keyperset: string) {
    const [open] = await handle
      .select()
      .from(rounds)
      .where(and(eq(rounds.keyperset, keyperset), stillOpen()))
      .limit(1);
    return open;
  }

  async function stateOf(roundId: string) {
    const asks = await handle.select().from(roundAsks).where(eq(roundAsks.roundId, roundId));
    const answers = await handle.select().from(roundAnswers).where(eq(roundAnswers.roundId, roundId));
    const answered = new Map(answers.map((a) => [a.userId, a]));
    return {
      asks,
      answers,
      waitingOn: asks.filter((a) => !answered.has(a.userId)).map((a) => a.keyper),
      answeredKeypers: asks.filter((a) => answered.has(a.userId)).map((a) => a.keyper),
    };
  }

  // Through `register`, not straight onto the instance: a plugin's routes are added when the server
  // is readied, which is after the OpenAPI hook exists. Registered directly they work but never
  // appear in `/openapi.json`, and AGENTS.md tells the agent that document is the truth about what
  // it can call -- so a route missing from it is a route the agent will never use.
  agentServer.fastify.register(async (fastify) => {
  // Opening. Returns the round that is already open for this keyperset rather than a second one:
  // two open rounds make an operator's reply ambiguous, and nothing would say which it answered.
  fastify.post(
    "/rounds",
    {
      schema: {
        tags: ["Rounds"],
        summary: "Ask every operator of a keyperset for a time window",
        description:
          "Opens a round: sends `question` to the keyper chat of every keyper in `keypers`, and " +
          "records what it is waiting for. Resolve the keyperset to its keypers yourself from the " +
          "dashboard first, then name them here.\n\n" +
          "**If that keyperset already has an open round, this opens nothing and sends nothing.** " +
          "It answers with `opened: false` and that round's state instead, which is what to tell the " +
          "room: a second round would make an operator's reply ambiguous. Close the old one first " +
          "if it is genuinely dead.\n\n" +
          "The answer names the keypers that have no registered chat. They were **not** asked and " +
          "nobody was told — say so, because a short fan-out otherwise looks exactly like a " +
          "complete one.\n\n" +
          "**Say that in words, never as a field name.** \"Every keyper had a chat\", or \"kpr-x has " +
          "no chat, so its operators were not asked\" -- never \"noChat empty\". The same goes for " +
          "everything else these routes answer with: `waitingOn`, `attemptsLeft`, all of it.\n\n" +
          "Which chat asked is taken from the Signal that woke you, never from the body. Word the " +
          "question so operators **reply to it**: a message they merely post in their room does not " +
          "reach you.\n\n" +
          "Each room's operator is @mentioned on a line above your text where their handle is known. That is added for you — **do not write an @handle yourself**, and do not ask anyone for one.",
        body: {
          type: "object",
          required: ["keyperset", "keypers", "question"],
          properties: {
            keyperset: { type: "string", description: "The set as a person would say it, e.g. `api-gnosis-1003`." },
            keypers: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
              description: "Every keyper in that set, by its Grafana `instance` label.",
            },
            question: { type: "string", description: "What each operator is asked. Compose it; do not forward anybody's words." },
          },
        },
      },
    },
    async (request, reply) => {
    const { keyperset, keypers, question } = (request.body ?? {}) as {
      keyperset?: string;
      keypers?: string[];
      question?: string;
    };
    if (!keyperset || !Array.isArray(keypers) || keypers.length === 0 || !question) {
      reply.code(400);
      return { error: "keyperset, a non-empty keypers array and question are all wanted" };
    }
    const context = current;
    if (context === undefined) {
      reply.code(409);
      return { error: "no Run is in flight, so there is no chat to open a round for" };
    }

    const existing = await openRoundFor(keyperset);
    if (existing !== undefined) {
      const state = await stateOf(existing.id);
      return {
        opened: false,
        round: { id: existing.id, keyperset, openedAt: existing.openedAt, question: existing.question },
        answered: state.answeredKeypers,
        waitingOn: state.waitingOn,
      };
    }

    const chats = await keyperChatsByKeyper(users, reachable);
    const { reachable: asking, noChat } = splitByChat(chats, keypers);
    if (asking.length === 0) {
      reply.code(409);
      return { error: "none of those keypers has a registered chat", noChat };
    }

    // Before the transaction: a read, and one query for the whole fan-out rather than one per chat
    // inside the write that creates the round.
    const usernames = await usernamesOf(asking.flatMap((chat) => chat.operators));

    const round = await db.tx(async (tx) => {
      const [created] = await tx
        .insert(rounds)
        .values({
          askedByUserId: context.userId,
          askedTelegramMessageId: context.telegramMessageId,
          keyperset,
          question,
        })
        .returning();
      await tx.insert(roundAsks).values(
        asking.map((chat) => ({ roundId: created.id, userId: chat.userId, keyper: chat.keyper })),
      );
      // In the same transaction as the asks, so a round nobody was asked for never exists.
      for (const chat of asking) {
        await messenger.send(tx, chat.userId, addressed(question, chat.operators, usernames));
      }
      return created;
    });

    return {
      opened: true,
      round: { id: round.id, keyperset, openedAt: round.openedAt, question },
      asked: asking.map((chat) => chat.keyper),
      // Named rather than silently dropped: a short fan-out otherwise looks exactly like a complete
      // one, and only a person reading this list can tell the difference.
      noChat,
    };
  },
  );

  // Recording an answer. The chat comes from the Run in flight, never from the agent.
  fastify.post(
    "/rounds/:id/answers",
    {
      schema: {
        tags: ["Rounds"],
        summary: "Record one operator's window",
        description:
          "Records the window this chat's operator gave, for a round this chat was asked in.\n\n" +
          "**`from` and `to` are UTC**, and reading them out of what the operator wrote is your " +
          "job: `\"3-5pm\"` becomes a date and a time. Ask them rather than guess if the day or the " +
          "zone is unclear — a window recorded wrongly still counts towards the round being " +
          "complete, and the result would name a time nobody can make. An unparseable window, or " +
          "one whose end is not after its start, is refused.\n\n" +
          "`said` is their own words, kept beside what you read out of them so the room can check.\n\n" +
          "Recording again **replaces**: an operator who corrects themselves has one answer, not " +
          "two. When the last operator answers, the result is reported to the room that asked, " +
          "without you doing anything further.",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", description: "The round this answers." } },
        },
        body: {
          type: "object",
          required: ["from", "to", "said"],
          properties: {
            from: { type: "string", description: "When the window opens, UTC, e.g. `2026-10-01T13:00:00Z`." },
            to: { type: "string", description: "When it closes, UTC. Must be after `from`." },
            said: { type: "string", description: "What the operator actually wrote." },
          },
        },
      },
    },
    async (request, reply) => {
    const { id } = request.params as { id: string };
    const { from, to, said } = (request.body ?? {}) as { from?: string; to?: string; said?: string };
    const context = current;
    if (context === undefined) {
      reply.code(409);
      return { error: "no Run is in flight, so there is no chat to record an answer for" };
    }
    if (!from || !to || !said) {
      reply.code(400);
      return { error: "from, to and said are all wanted; from and to are UTC times" };
    }

    let window: { from: Date; to: Date };
    try {
      window = parseWindow(from, to);
    } catch (error) {
      if (!(error instanceof MalformedWindowError)) throw error;
      // Refused rather than recorded: a window that means nothing would still count towards the
      // round being complete.
      reply.code(400);
      return { error: error.message };
    }

    const [ask] = await handle
      .select()
      .from(roundAsks)
      .where(and(eq(roundAsks.roundId, id), eq(roundAsks.userId, context.userId)))
      .limit(1);
    if (ask === undefined) {
      reply.code(404);
      return { error: `this chat was not asked in round ${id}` };
    }

    const completed = await db.tx(async (tx) => {
      await tx
        .insert(roundAnswers)
        .values({
          roundId: id,
          userId: context.userId,
          fromAt: window.from,
          toAt: window.to,
          said,
        })
        // A correction replaces: "actually, make that 4-6" is one answer, not two.
        .onConflictDoUpdate({
          target: [roundAnswers.roundId, roundAnswers.userId],
          set: { fromAt: window.from, toAt: window.to, said, recordedAt: sql`clock_timestamp()` },
        });

      // Everybody answered, or nobody needs waking.
      const [{ asked, answered }] = await tx
        .select({
          asked: sql<number>`(select count(*)::int from ${roundAsks} where ${roundAsks.roundId} = ${id})`,
          answered: sql<number>`(select count(*)::int
                                   from ${roundAnswers} ans
                                   join ${roundAsks} ask
                                     on ask.round_id = ans.round_id and ask.user_id = ans.user_id
                                  where ans.round_id = ${id}
                                    and ans.recorded_at > coalesce(ask.revise_asked_at, 'epoch'::timestamptz))`,
        })
        .from(rounds)
        .where(eq(rounds.id, id));
      if (asked !== answered) return false;

      // Whether this is the end is decided here rather than by the agent: a round ends when the
      // windows actually meet, or when the operators have been asked to revise as often as they are
      // going to be. A revision re-enters this path and is evaluated again.
      const answers = await tx.select().from(roundAnswers).where(eq(roundAnswers.roundId, id));
      const meets = overlapOf(answers.map((a) => ({ from: a.fromAt, to: a.toAt }))) !== undefined;
      const [round] = await tx.select().from(rounds).where(eq(rounds.id, id)).limit(1);
      const final = meets || round.attempts >= maxAttempts;

      if (final) {
        // Only from null, so a correction arriving after the report cannot report a second time.
        const [stamped] = await tx
          .update(rounds)
          .set({ reportedAt: sql`clock_timestamp()` })
          .where(and(eq(rounds.id, id), isNull(rounds.reportedAt)))
          .returning({ id: rounds.id });
        if (stamped === undefined) return false;
      } else if (round.reportedAt !== null) {
        return false;
      }
      await worker.emit(tx, { kind: roundCompletedKind, payload: { roundId: id } });
      return true;
    });

    const state = await stateOf(id);
    return { recorded: true, complete: completed, waitingOn: state.waitingOn };
  },
  );

  // Where a round stands, for a teammate who asks. The honest answer to a silent operator: nothing
  // expires here, so this is the only thing that makes waiting visible.
  fastify.get(
    "/rounds",
    {
      schema: {
        tags: ["Rounds"],
        summary: "Where the open rounds stand",
        description:
          "Every open round, or those for one keyperset. `answered` and `waitingOn` name keypers.\n\n" +
          "This is the honest answer when somebody asks how a round is going: nothing here expires, " +
          "so an operator who has not replied is simply still being waited for. Say who.",
        querystring: {
          type: "object",
          properties: { keyperset: { type: "string", description: "Narrow to one keyperset." } },
        },
      },
    },
    async (request) => {
    const { keyperset } = request.query as { keyperset?: string };
    const open = await handle
      .select()
      .from(rounds)
      .where(keyperset ? and(eq(rounds.keyperset, keyperset), stillOpen()) : stillOpen());
    return {
      rounds: await Promise.all(
        open.map(async (round) => {
          const state = await stateOf(round.id);
          return {
            id: round.id,
            keyperset: round.keyperset,
            question: round.question,
            openedAt: round.openedAt,
            reportedAt: round.reportedAt,
            answered: state.answeredKeypers,
            waitingOn: state.waitingOn,
          };
        }),
      ),
    };
  },
  );

  // Asking some of the operators to move. The round stays open: their revision replaces their
  // answer and the round is evaluated again, which is what converges it.
  fastify.post(
    "/rounds/:id/revise",
    {
      schema: {
        tags: ["Rounds"],
        summary: "Ask some operators to revise their window",
        description:
          "Sends `text` to the chats of the named keypers and counts one attempt against the " +
          "round. Their replies replace their earlier answers, and the round is worked out again " +
          "once they are all in — you do not need to do anything else for that.\n\n" +
          "**Bounded.** After " +
          String(maxAttempts) +
          " attempts this is refused and the round reports what it has. Every attempt asks somebody " +
          "who already answered to change their plans, which costs them something.\n\n" +
          "Name a target window in `text`, and keep whatever day or range the team asked for in the " +
          "first place: converging on something concrete is faster than asking people to try again.\n\n" +
          "Each room's operator is @mentioned on a line above your text where their handle is known. That is added for you — **do not write an @handle yourself**, and do not ask anyone for one.",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["keypers", "text"],
          properties: {
            keypers: {
              type: "array",
              minItems: 1,
              items: { type: "string" },
              description: "Whose operators are asked to move.",
            },
            text: { type: "string", description: "What they are asked. Name the window to aim at." },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { keypers, text } = (request.body ?? {}) as { keypers?: string[]; text?: string };
      if (!Array.isArray(keypers) || keypers.length === 0 || !text) {
        reply.code(400);
        return { error: "a non-empty keypers array and text are wanted" };
      }
      const [round] = await handle.select().from(rounds).where(eq(rounds.id, id)).limit(1);
      if (round === undefined || round.closedAt !== null || round.reportedAt !== null) {
        reply.code(404);
        return { error: `no open round ${id}; a round that has reported is already finished` };
      }
      if (round.attempts >= maxAttempts) {
        reply.code(409);
        return {
          error: `round ${id} has already used its ${maxAttempts} revision attempts`,
          attempts: round.attempts,
        };
      }

      const asks = await handle.select().from(roundAsks).where(eq(roundAsks.roundId, id));
      const asking = asks.filter((a) => keypers.includes(a.keyper));
      if (asking.length === 0) {
        reply.code(404);
        return { error: "none of those keypers was asked in this round" };
      }

      // Resolved fresh rather than remembered from when the round opened: an operator may have been
      // recorded, or the room re-registered, in between. A chat removed since is simply absent here
      // and its message goes out unaddressed, exactly as it would have before.
      const operatorsByUser = new Map<string, readonly string[]>();
      for (const chats of (await keyperChatsByKeyper(users, reachable)).values()) {
        for (const chat of chats) operatorsByUser.set(chat.userId, chat.operators);
      }
      const usernames = await usernamesOf(
        asking.flatMap((ask) => [...(operatorsByUser.get(ask.userId) ?? [])]),
      );

      const attempts = await db.tx(async (tx) => {
        const [{ attempts }] = await tx
          .update(rounds)
          .set({ attempts: sql`${rounds.attempts} + 1` })
          .where(eq(rounds.id, id))
          .returning({ attempts: rounds.attempts });
        await tx
          .update(roundAsks)
          .set({ reviseAskedAt: sql`clock_timestamp()` })
          .where(
            and(
              eq(roundAsks.roundId, id),
              inArray(
                roundAsks.userId,
                asking.map((a) => a.userId),
              ),
            ),
          );
        for (const ask of asking) {
          const operators = operatorsByUser.get(ask.userId) ?? [];
          await messenger.send(tx, ask.userId, addressed(text, operators, usernames));
        }
        return attempts;
      });

      return {
        asked: asking.map((a) => a.keyper),
        attempts,
        attemptsLeft: maxAttempts - attempts,
      };
    },
  );

  // Closing, so a keyperset can be asked again. A person's judgement that a round is dead, never
  // automatic: with no timers, one permanently silent operator would otherwise block its keyperset
  // for good.
  fastify.post(
    "/rounds/:id/close",
    {
      schema: {
        tags: ["Rounds"],
        summary: "Close a round so its keyperset can be asked again",
        description:
          "Marks a round closed, freeing its keyperset to be asked again.\n\n" +
          "**A round that has reported needs no closing** — it ended when the last operator " +
          "answered. This is only for a round that will never complete, because an operator will " +
          "never reply: nothing expires on its own, so that one would block its keyperset for good.\n\n" +
          "Only when somebody in the room judges it dead. Do not close a round to work around " +
          "waiting: say who is still being waited on instead.",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", description: "The round to close." } },
        },
      },
    },
    async (request, reply) => {
    const { id } = request.params as { id: string };
    const [closed] = await handle
      .update(rounds)
      .set({ closedAt: sql`clock_timestamp()` })
      .where(and(eq(rounds.id, id), stillOpen()))
      .returning({ id: rounds.id, keyperset: rounds.keyperset });
    if (closed === undefined) {
      // Either it never existed, or it already ended. A round that reported is finished and closed
      // itself; there is nothing here to do and saying so is better than pretending to close it.
      reply.code(404);
      return { error: `no open round ${id}; a round that has reported is already finished` };
    }
    return { closed: true, keyperset: closed.keyperset };
  },
  );
  });

  return {
    /** Told by the Handler which chat the Run in flight is acting for, before the Run starts. */
    actingFor(context: RunContext | undefined): void {
      current = context;
    },
    /**
     * The open round this chat was asked in and has not answered, if there is one. The Handler puts
     * it in the prompt: without it the agent has no way to know an operator's message is an answer
     * rather than an ordinary question.
     */
    async awaiting(userId: string) {
      const [row] = await handle
        .select({ id: rounds.id, keyperset: rounds.keyperset, question: rounds.question })
        .from(roundAsks)
        .innerJoin(rounds, eq(rounds.id, roundAsks.roundId))
        .where(and(eq(roundAsks.userId, userId), isNull(rounds.closedAt), isNull(rounds.reportedAt)))
        .limit(1);
      if (row === undefined) return undefined;
      const [answered] = await handle
        .select({ roundId: roundAnswers.roundId })
        .from(roundAnswers)
        .innerJoin(
          roundAsks,
          and(eq(roundAsks.roundId, roundAnswers.roundId), eq(roundAsks.userId, roundAnswers.userId)),
        )
        .where(and(eq(roundAnswers.roundId, row.id), eq(roundAnswers.userId, userId), answeredSinceAsked))
        .limit(1);
      return answered === undefined ? row : undefined;
    },
    /** What the report needs: the round, who was asked, and what each of them said. */
    async report(roundId: string) {
      const [round] = await handle.select().from(rounds).where(eq(rounds.id, roundId)).limit(1);
      if (round === undefined) return undefined;
      const state = await stateOf(roundId);
      const byUser = new Map(state.answers.map((a) => [a.userId, a]));
      return {
        round,
        attemptsLeft: maxAttempts - round.attempts,
        windows: state.asks.flatMap((ask) => {
          const answer = byUser.get(ask.userId);
          return answer === undefined ? [] : [{ keyper: ask.keyper, ...answer }];
        }),
        waitingOn: state.waitingOn,
      };
    },
    async start() {},
    async stop() {},
  };
}

export type Rounds = ReturnType<typeof createRounds>;
