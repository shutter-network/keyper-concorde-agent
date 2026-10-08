import { createGateway } from "@shutter-network/concorde/gateway";
import {
  createMessenger,
  type MessageRecord,
  messageReceivedKind,
} from "@shutter-network/concorde/messenger";
import { createPasswordAuth } from "@shutter-network/concorde/password-auth";
import { createPiRuntime } from "@shutter-network/concorde/pi";
import {
  createScheduler,
  type ScheduleFiredRecord,
  scheduleFiredKind,
} from "@shutter-network/concorde/scheduler";
import {
  type PostOutcome,
  type Signal,
  templateHandler,
} from "@shutter-network/concorde/signals";
import { createUsers } from "@shutter-network/concorde/users";
import { describeCoverage, type KeyperRef, promptData } from "./prompt.ts";
import { teammateRoom } from "./report/rooms.ts";
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
    // The one Channel. Telegram replaces the HTTP Channel, so the public message routes are gone.
    // Accept group chats only. Reject private chats before storing a Message because they
    // have no assigned keyper.
    const telegram = createTelegramChannel({
      db,
      messenger,
      token: process.env.TG_TOKEN!,
      chatMode: "group",
    });
    // Wakes the agent on a timetable. `agentServer` is deliberately not passed, so no schedule
    // routes are registered and the agent cannot create or cancel a Schedule.
    const scheduler = createScheduler({ db, worker });
    return { users, passwordAuth, messenger, telegram, scheduler };
  },
  handlers: ({ db, messenger, telegram, users }) => ({
    [messageReceivedKind]: {
      ...templateHandler<MessageRecord>({
        template: `A message arrived from {{#if covers}}the group for {{covers}}{{else}}the teammates' group{{/if}}.{{#if role}} It was written by {{role}}.{{/if}} They said:

{{text}}

Answer them by sending a Message to user {{userId}}. Your final reply here reaches nobody.`,
        session: (signal) => `user_${signal.payload.userId}`,
        // Read the database here so prompt.ts can build prompt data without database access.
        data: async (signal) => {
          const sender = await db.tx((tx) => telegram.senderOf(tx, signal.payload.id));
          const user = await users.get(signal.payload.userId);
          return promptData(signal.payload, sender, user?.attributes);
        },
      }),
      // The template handler does not notify users when a Run fails.
      // Send a failure message here so the sender receives an answer as well as a log entry.
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

    // Fired by the weekly Schedule below. The report itself is built an hour earlier by the
    // report-cron service, so this only tells the agent that today's file is there to read.
    [scheduleFiredKind]: {
      async handle(signal: Signal<ScheduleFiredRecord>) {
        const { data, firedAt } = signal.payload;
        const dir = (data as { reportDir?: string })?.reportDir ?? "/workspace/reports";
        const today = firedAt.slice(0, 10);
        const team = await teammateRoom(users);
        if (team === undefined) {
          console.error("a weekly report fired but no teammate chat is registered");
          return [];
        }
        return [
          {
            session: `weekly_report_${today}`,
            text:
              `The weekly Keyper uptime report for ${today} has been built. The reports are in ` +
              `${dir}, named by the date and time they were built. List that directory and read ` +
              `the newest file whose name starts with ${today}. More than one report can exist ` +
              `for one day, and only the newest is current. Then follow the Weekly uptime report ` +
              `duty in AGENTS.md.\n\n` +
              `Send what you have to say to user ${team.userId}, which is the teammates' group. ` +
              `Your final reply here reaches nobody.`,
          },
        ];
      },
      // A failed Run is otherwise one log line, and the team would wait for a report that never
      // arrives without knowing one was due.
      async post(signal: Signal<ScheduleFiredRecord>, outcome: PostOutcome) {
        if (!outcome.failed) return;
        const team = await teammateRoom(users);
        if (team === undefined) return;
        await db.tx((tx) =>
          messenger.send(
            tx,
            team.userId,
            `The weekly Keyper uptime report for ${signal.payload.firedAt.slice(0, 10)} was built, ` +
              `but I could not read it. Ask me to read it again, or check the gateway log.`,
          ),
        );
      },
    },
  }),
});

await gateway.start();

await gateway.components.scheduler.schedule({
  name: "weekly-uptime-report",
  spec: { kind: "cron", expr: "0 14 * * 1", tz: "UTC" },
  data: { reportDir: "/workspace/reports" },
});

// Do not create default Users at startup. Register groups through `admin.ts`, which saves
// the chat link and any keyper assignment together. This avoids creating Users that cannot
// receive messages or keyper groups with no assigned keyper.
//
// Name a keyper group that covers nothing. Such a group raises UnboundGroupError on every message
// it sends, so saying so at boot turns a silent runtime failure into one line in the log.
const groups = await gateway.components.users.list();
console.log(`gateway is up, serving ${groups.length} group${groups.length === 1 ? "" : "s"}`);
for (const group of groups) {
  const { name, kind, keypers } = (group.attributes ?? {}) as {
    name?: string;
    kind?: string;
    keypers?: readonly KeyperRef[];
  };
  const covers = describeCoverage(Array.isArray(keypers) ? keypers : []);
  console.log(
    kind === "teammate"
      ? `  ${name ?? "(unnamed)"} is a teammate chat`
      : `  ${name ?? "(unnamed)"} covers ${covers ?? "nothing; run admin.ts add-keypers for it"}`,
  );
}
if (groups.length === 0) console.log("  none registered yet; see admin.ts add-keyper-chat");

for (const stopping of ["SIGINT", "SIGTERM"] as const) {
  process.once(stopping, () => void gateway.stop());
}
