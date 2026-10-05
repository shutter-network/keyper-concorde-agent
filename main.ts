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
    return { users, passwordAuth, messenger, telegram };
  },
  handlers: ({ db, messenger, telegram, users }) => ({
    [messageReceivedKind]: {
      ...templateHandler<MessageRecord>({
        template: `A message arrived from {{#if keyper}}the group for keyper {{keyper}}{{else}}the teammates' group{{/if}}.{{#if role}} It was written by {{role}}.{{/if}} They said:

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
  }),
});

await gateway.start();

// Do not create default Users at startup. Register groups through `admin.ts`, which saves
// the chat link and any keyper assignment together. This avoids creating Users that cannot
// receive messages or keyper groups with no assigned keyper.
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
if (groups.length === 0) console.log("  none registered yet; see admin.ts add-keyper-chat");

for (const stopping of ["SIGINT", "SIGTERM"] as const) {
  process.once(stopping, () => void gateway.stop());
}
