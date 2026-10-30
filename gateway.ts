// The Gateway as production runs it, built but not started. main.ts starts it with the
// deployment's environment; the behaviour tests build the same one against a test database, a
// fake Telegram API and their own paths. Importing this file starts nothing.

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
import { failureMessage, promptData, template } from "./prompt.ts";
import { teammateRoom } from "./report/rooms.ts";
import { createTelegramChannel } from "./telegram-channel/index.ts";

const tokenTtl = 30 * 24 * 60 * 60 * 1000;

export type AgentOptions = {
  readonly image: string;
  readonly network: string;
  /** The Gateway's agent server, as the agent container reaches it. */
  readonly serverUrl: string;
  /** The host directory the paths below are relative to. */
  readonly runtimeDir: string;
  readonly paths: {
    readonly workspace: string;
    /** pi's own directory: sessions and the files it keeps between Runs. */
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
 * One agent container per Run. Its environment is fixed here and takes no option, so production
 * and the tests give the agent the same thing.
 */
export function createAgentRuntime(agent: AgentOptions): Runtime {
  const { paths } = agent;
  return createPiRuntime({
    image: agent.image,
    // Only what is named here reaches the agent container, and no model credential is named: the
    // litellm service holds those and adds the header on the way out, so an agent that reads its
    // own environment finds nothing worth having. `models.json` is what points pi at the proxy.
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
      // Telegram replaces the HTTP Channel; public HTTP message routes are not registered.
      // Accept group chats only. Reject private chats before storing a Message because they
      // have no assigned keyper.
      const telegram = createTelegramChannel({
        db,
        messenger,
        ...options.telegram,
        ...logger,
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
          template,
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
          await db.tx((tx) => messenger.send(tx, signal.payload.userId, failureMessage));
        },
      },

      // Fired by the weekly Schedule main.ts registers. The report itself is built an hour earlier
      // by the report-cron service, so this only tells the agent that today's file is there to read.
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
}
