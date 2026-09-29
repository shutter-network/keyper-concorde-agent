import { createGateway } from "@shutter-network/concorde/gateway";
import {
  createMessenger,
  type MessageRecord,
  messageReceivedKind,
} from "@shutter-network/concorde/messenger";
import { createPasswordAuth } from "@shutter-network/concorde/password-auth";
import { createPiRuntime } from "@shutter-network/concorde/pi";
import {
  type PostOutcome,
  type Signal,
  templateHandler,
} from "@shutter-network/concorde/signals";
import { createUsers } from "@shutter-network/concorde/users";
import { promptData } from "./prompt.ts";
import { createAnnouncements } from "./coordination/announce.ts";
import { createRounds, roundCompletedKind, type RoundCompleted } from "./coordination/rounds.ts";
import { largestAgreement, overlapOf } from "./coordination/windows.ts";
import { createTelegramChannel } from "./telegram-channel/index.ts";

const tokenTtl = 30 * 24 * 60 * 60 * 1000;

// Only what is named here reaches the agent container. Whichever provider keys are set in the
// environment are forwarded, so switching provider is a change to .env and the two pi files,
// not a rebuild.
const providerKeys = ["ANTHROPIC_API_KEY", "LOCAL_API_KEY"];
const providerEnv = Object.fromEntries(
  providerKeys.filter((name) => process.env[name]).map((name) => [name, process.env[name]!]),
);

const runtime = createPiRuntime({
  image: process.env.AGENT_IMAGE!,
  env: {
    ...providerEnv,
    AGENT_SERVER_URL: process.env.AGENT_SERVER_URL!,
  },
  networks: [process.env.AGENT_NETWORK!],
  mounts: {
    runtimeDir: process.env.RUNTIME_DIR_HOST!,
    entries: [
      { agentPath: "/workspace", path: "state/workspace" },
      { agentPath: "/home/agent/.pi/agent", path: "state/agent" },
      { agentPath: "/workspace/AGENTS.md", path: "AGENTS.md", readOnly: true },
      { agentPath: "/home/agent/.pi/agent/settings.json", path: "settings.json", readOnly: true },
      { agentPath: "/home/agent/.pi/agent/models.json", path: "models.json", readOnly: true },
    ],
  },
});

const gateway = createGateway({
  databaseUrl: process.env.DATABASE_URL!,
  runtime,
  publicListen: { host: process.env.PUBLIC_HOST!, port: Number(process.env.PUBLIC_PORT) },
  agentListen: { host: process.env.AGENT_HOST!, port: Number(process.env.AGENT_PORT) },
  extend: ({ db, agentServer, publicServer, worker }) => {
    const users = createUsers({ db, agentServer, publicServer });
    const passwordAuth = createPasswordAuth({ db, users, publicServer, tokenTtl });
    const messenger = createMessenger({ db, users, worker, agentServer });
    // Rounds: one question to every keyper chat of a keyperset, and the answers it waits for. All
    // the counting lives here rather than in the agent, which only reads windows out of prose.
    // A User with a keyper is not the same as a keyper that can be reached: `remove-chat` leaves
    // the User behind, so the Channel is asked rather than assumed.
    const reachable = async (userId: string) =>
      (await db.tx((tx) => telegram.chatOf(tx, userId))) !== undefined;
    const rounds = createRounds({ db, users, messenger, worker, agentServer, reachable });
    // The other half: telling each keyper's operators something and waiting for nothing.
    const announcements = createAnnouncements({ db, users, messenger, agentServer, reachable });
    // The one Channel. Telegram replaces the HTTP Channel, so the public message routes are gone.
    // Groups only. Every User here is a room bound to one keyper, so a 1:1 chat has no keyper to
    // answer about and is refused before it becomes a Message.
    const telegram = createTelegramChannel({
      db,
      messenger,
      token: process.env.TG_TOKEN!,
      chatMode: "group",
    });
    return { users, passwordAuth, messenger, telegram, rounds, announcements };
  },
  handlers: ({ db, messenger, telegram, users, rounds }) => ({
    [messageReceivedKind]: {
      ...templateHandler<MessageRecord>({
        template: `A message arrived from {{#if keyper}}the group for keyper {{keyper}}{{else}}the teammates' group{{/if}}.{{#if role}} It was written by {{role}}.{{/if}}{{#if openRound}} You asked this group for a time window for keyperset {{openRound.keyperset}} and they have not answered yet; that is round {{openRound.id}}.{{/if}} Today is {{today}}, UTC. They said:

{{text}}

Answer them by sending a Message to user {{userId}}. Your final reply here reaches nobody.`,
        session: (signal) => `user_${signal.payload.userId}`,
        // The reads, so that assembling the values stays pure and testable in prompt.ts.
        data: async (signal) => {
          const sender = await db.tx((tx) => telegram.senderOf(tx, signal.payload.id));
          const user = await users.get(signal.payload.userId);
          telegram.expectReplyTo(signal.payload.userId, sender?.telegramMessageId ?? null);
          // The same context, so the round routes need no ids from the agent. Both rest on one Run
          // being in flight at a time.
          rounds.actingFor({
            userId: signal.payload.userId,
            telegramMessageId: sender?.telegramMessageId ?? null,
          });
          return promptData(
            signal.payload,
            sender,
            user?.attributes,
            await rounds.awaiting(signal.payload.userId),
          );
        },
      }),
      // The template handler has no failure path. Without this, a failed run is a log line
      // and the sender hears nothing.
      async post(signal: Signal<MessageRecord>, outcome: PostOutcome) {
        if (!outcome.failed) return;
        await db.tx((tx) =>
          messenger.send(
            tx,
            signal.payload.userId,
            "I could not process your last message. Please try again in a few minutes.",
          ),
        );
      },
    },

    // Emitted by code when the last operator answers. The overlap is worked out here, not by the
    // model: reading "3-5pm CET" out of prose needs language, deciding whether five windows overlap
    // does not, and a wrong answer here would name a time nobody can make.
    [roundCompletedKind]: {
      ...templateHandler<RoundCompleted>({
        template: `Every operator asked about keyperset {{keyperset}} has answered.

{{#each windows}}- {{keyper}} said "{{said}}", which is {{from}} to {{to}} UTC
{{/each}}
{{#if overlap}}All {{total}} of them overlap from {{overlap.from}} to {{overlap.to}} UTC.{{else}}{{#if agreement}}No window works for all {{total}}. The largest group that can meet is {{agreement.count}} of {{total}}, from {{agreement.from}} to {{agreement.to}} UTC: {{agreement.agreed}}. Outside it: {{agreement.outside}}.{{else}}No two of them overlap at all.{{/if}}{{/if}}

Report this to user {{userId}}, in this order: every operator's window as they gave it; then {{#if overlap}}the window they all share{{else}}the largest group that can meet, when and who, and who is outside it{{/if}}.{{#unless overlap}} Then say they can open a fresh round suggesting a specific day or window, so the operators have something to converge on.{{/unless}} Times are UTC. Do not pick a time for them and do not open anything yourself; a person decides. Your final reply here reaches nobody.`,
        session: (signal) => `round_${signal.payload.roundId}`,
        data: async (signal) => {
          const found = await rounds.report(signal.payload.roundId);
          if (found === undefined) throw new Error(`no round ${signal.payload.roundId}`);
          const entries = found.windows.map((w) => ({
            keyper: w.keyper,
            window: { from: w.fromAt, to: w.toAt },
          }));
          const overlap = overlapOf(entries.map((e) => e.window));
          // Only when they do not all agree: "the largest group is all of them" is the overlap
          // restated, and saying it twice would read as two different findings.
          const agreement = overlap === undefined ? largestAgreement(entries) : undefined;
          const agreed = new Set(agreement?.members.map((m) => m.keyper) ?? []);
          // The report quotes the question that opened the round, however long ago that was.
          telegram.expectReplyTo(found.round.askedByUserId, found.round.askedTelegramMessageId);
          rounds.actingFor(undefined);
          return {
            userId: found.round.askedByUserId,
            keyperset: found.round.keyperset,
            windows: found.windows.map((w) => ({
              keyper: w.keyper,
              said: w.said,
              from: w.fromAt.toISOString(),
              to: w.toAt.toISOString(),
            })),
            total: entries.length,
            overlap:
              overlap === undefined
                ? null
                : { from: overlap.from.toISOString(), to: overlap.to.toISOString() },
            agreement:
              agreement === undefined
                ? null
                : {
                    from: agreement.window.from.toISOString(),
                    to: agreement.window.to.toISOString(),
                    count: agreement.members.length,
                    agreed: agreement.members.map((m) => m.keyper).join(", "),
                    outside: entries
                      .filter((e) => !agreed.has(e.keyper))
                      .map((e) => e.keyper)
                      .join(", "),
                  },
          };
        },
      }),
      // templateHandler has no failure path, and `reportedAt` is already stamped, so without this a
      // failed report is silence and nothing re-emits it. The state route is how they recover.
      async post(signal: Signal<RoundCompleted>, outcome: PostOutcome) {
        if (!outcome.failed) return;
        const found = await rounds.report(signal.payload.roundId);
        if (found === undefined) return;
        await db.tx((tx) =>
          messenger.send(
            tx,
            found.round.askedByUserId,
            `Every operator answered about keyperset ${found.round.keyperset}, but I could not put the result together. Ask me where that round stands.`,
          ),
        );
      },
    },
  }),
});

await gateway.start();

// Nothing is seeded. A User here is a group bound to a keyper, and one with neither chat nor keyper
// could receive nothing and answer about nothing. `admin.ts add` is the only place a group is made,
// and the only place a chat and its keyper are recorded together.
//
// Password Auth is still built, so the Public server's User routes keep the hook that refuses them.
// Nobody holds a password, so nobody logs in, which is what a deployment reached only over Telegram
// wants.
//
// One line at boot, because the framework says nothing until something happens, and a silent log
// otherwise reads the same whether the gateway is idle or never came up.
const groups = await gateway.components.users.list();
console.log(`gateway is up, serving ${groups.length} group${groups.length === 1 ? "" : "s"}`);
for (const group of groups) {
  const { name, kind, keyper } = (group.attributes ?? {}) as {
    name?: string;
    kind?: string;
    keyper?: string;
  };
  console.log(
    kind === "teammate"
      ? `  ${name ?? "(unnamed)"} is a teammate chat`
      : `  ${name ?? "(unnamed)"} covers keyper ${keyper ?? "(none bound)"}`,
  );
}
if (groups.length === 0) console.log("  none registered yet; see admin.ts add");

for (const stopping of ["SIGINT", "SIGTERM"] as const) {
  process.once(stopping, () => void gateway.stop());
}
