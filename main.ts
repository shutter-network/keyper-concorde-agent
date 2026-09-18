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
import { createTelegramChannel } from "./telegram-channel/index.ts";

const password = process.env.USER_PASSWORD!;

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
    const telegram = createTelegramChannel({ db, messenger, token: process.env.TG_TOKEN! });
    return { users, passwordAuth, messenger, telegram };
  },
  handlers: ({ db, messenger }) => ({
    [messageReceivedKind]: {
      ...templateHandler<MessageRecord>({
        template: `A message arrived for you from user {{userId}}. They said:

{{text}}

Answer them by sending them a Message. Your final reply here reaches nobody.`,
        session: (signal) => `user_${signal.payload.userId}`,
        data: (signal) => signal.payload,
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
  }),
});

await gateway.start();

const { db, users, passwordAuth, telegram } = gateway.components;

if ((await users.list({ limit: 1 })).length === 0) {
  await db.tx(async (tx) => {
    const user = await users.create(tx);
    await users.setAttributes(tx, user.id, { name: "the one person here" });
    await passwordAuth.setPassword(tx, user.id, password);
  });
}

for (const user of await users.list()) {
  console.log(`user ${user.id} logs in with the password ${password}`);
}

// Attach the tester's chat to the seeded user, once. Later users get their chats recorded by
// hand from the id the Channel tells an unknown chat.
const testerChat = process.env.TG_CHAT;
if (testerChat) {
  const [first] = await users.list({ limit: 1 });
  if (first !== undefined && (await db.tx((tx) => telegram.chatOf(tx, first.id))) === undefined) {
    await db.tx((tx) => telegram.recordChat(tx, first.id, testerChat));
    console.log(`telegram chat ${testerChat} now belongs to user ${first.id}`);
  }
}

for (const stopping of ["SIGINT", "SIGTERM"] as const) {
  process.once(stopping, () => void gateway.stop());
}
