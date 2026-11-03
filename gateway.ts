// Shared gateway and agent setup for production and tests.
// Callers provide configuration and start the gateway explicitly.

import type { Logger } from "@shutter-network/concorde/logging";
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
  type Runtime,
  type Signal,
  templateHandler,
} from "@shutter-network/concorde/signals";
import { createUsers } from "@shutter-network/concorde/users";
import { sql } from "drizzle-orm";
import { failureMessage, promptData, template } from "./prompt.ts";
import { teammateRoom } from "./report/rooms.ts";
import { createTelegramChannel } from "./telegram-channel/index.ts";

const tokenTtl = 30 * 24 * 60 * 60 * 1000;

export type AgentOptions = {
  readonly image: string;
  readonly network: string;
  /** Agent server URL reachable from the agent container. */
  readonly serverUrl: string;
  /** Host directory used to resolve the paths below. */
  readonly runtimeDir: string;
  readonly paths: {
    readonly workspace: string;
    /** Persistent Pi state, including sessions. */
    readonly state: string;
    readonly agentsMd: string;
    readonly settings: string;
    readonly models: string;
    readonly systemMd: string;
  };
  /** Extra `docker run` arguments, such as a container name. */
  readonly extraArgs?: readonly string[];
};

/**
 * Create one agent container per run, using the same environment configuration in production and tests.
 */
export function createAgentRuntime(agent: AgentOptions): Runtime {
  const { paths } = agent;
  return createPiRuntime({
    image: agent.image,
    // Provider keys stay in LiteLLM. models.json points Pi at the proxy.
    env: {
      AGENT_SERVER_URL: agent.serverUrl,
    },
    networks: [agent.network],
    ...(agent.extraArgs ? { extraArgs: [...agent.extraArgs] } : {}),
    mounts: {
      runtimeDir: agent.runtimeDir,
      entries: [
        { agentPath: "/workspace", path: paths.workspace },
        { agentPath: "/home/agent/.pi/agent", path: paths.state },
        { agentPath: "/workspace/AGENTS.md", path: paths.agentsMd, readOnly: true },
        { agentPath: "/home/agent/.pi/agent/settings.json", path: paths.settings, readOnly: true },
        { agentPath: "/home/agent/.pi/agent/models.json", path: paths.models, readOnly: true },
        // Replaces pi's built-in system prompt. AGENTS.md is appended after it.
        { agentPath: "/home/agent/.pi/agent/SYSTEM.md", path: paths.systemMd, readOnly: true },
      ],
    },
  });
}

type Listen = { readonly host: string; readonly port: number };

export type GatewayOptions = {
  readonly databaseUrl: string;
  readonly runtime: Runtime;
  readonly publicListen: Listen;
  readonly agentListen: Listen;
  readonly telegram: {
    readonly token: string;
    readonly apiBaseUrl?: string;
    readonly pollTimeoutSeconds?: number;
    readonly retryDelayMs?: number;
  };
  readonly logger?: Logger;
};

export function buildGateway(options: GatewayOptions) {
  const logger = options.logger ? { logger: options.logger } : {};
  return createGateway({
    databaseUrl: options.databaseUrl,
    runtime: options.runtime,
    publicListen: options.publicListen,
    agentListen: options.agentListen,
    ...logger,
    extend: ({ db, agentServer, publicServer, worker }) => {
      const users = createUsers({ db, agentServer, publicServer });
      const passwordAuth = createPasswordAuth({ db, users, publicServer, tokenTtl });
      const messenger = createMessenger({ db, users, worker, agentServer });
      // Use Telegram for messaging and reject private chats before storing messages.
      const telegram = createTelegramChannel({
        db,
        messenger,
        ...options.telegram,
        ...logger,
        chatMode: "group",
      });
      // Omitting agentServer prevents the agent from creating or cancelling schedules through the API.
      const scheduler = createScheduler({ db, worker });

      publicServer.fastify.get("/health", async (_request, reply) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            db.handle({}).execute(sql`select 1`),
            new Promise((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error("database check timed out")), 3000);
            }),
          ]);
          return { status: "ok" };
        } catch (error) {
          reply.code(503);
          return { status: "unhealthy", detail: String(error) };
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      });

      return { users, passwordAuth, messenger, telegram, scheduler };
    },
    handlers: ({ db, messenger, telegram, users }) => ({
      [messageReceivedKind]: {
        ...templateHandler<MessageRecord>({
          template,
          session: (signal) => `user_${signal.payload.userId}`,
          // Load records here to keep prompt.ts independent of the database.
          data: async (signal) => {
            const sender = await db.tx((tx) => telegram.senderOf(tx, signal.payload.id));
            const user = await users.get(signal.payload.userId);
            return promptData(signal.payload, sender, user?.attributes);
          },
        }),
        // Notify the sender when a run fails.
        async post(signal: Signal<MessageRecord>, outcome: PostOutcome) {
          if (!outcome.failed) return;
          await db.tx((tx) => messenger.send(tx, signal.payload.userId, failureMessage));
        },
      },

      // Handle the weekly schedule from main.ts. report-cron generates the report an hour earlier.
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
        // Notify the team if the scheduled agent run fails.
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
}
