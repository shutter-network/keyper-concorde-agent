// Telling each keyper's operators something, expecting nothing back.
//
// The other half of what a teammates' group can set in motion. A round asks a question and waits for
// every answer; this says something and is finished. Uptime reported to each keyper's own chat is
// the case it exists for, and each chat gets its own text rather than one broadcast -- an operator
// wants their keyper's number, not the fleet's.
//
// Nothing is recorded beyond the Messages themselves. There is nothing to wait for, so there is
// nothing to be complete, and the message log is already the durable record.

import type { Db } from "@shutter-network/concorde/db";
import type { ServerComponent } from "@shutter-network/concorde/gateway";
import type { Messenger } from "@shutter-network/concorde/messenger";
import type { Users } from "@shutter-network/concorde/users";
import { keyperChatsByKeyper } from "./keyper-chats.ts";
import { addressed } from "./mentions.ts";

export type AnnouncementsOptions = {
  readonly db: Db;
  readonly users: Users;
  readonly messenger: Messenger;
  readonly agentServer: ServerComponent;
  /** Whether a User can be written to at all. A User with no chat is not a keyper's chat. */
  readonly reachable: (userId: string) => Promise<boolean>;
  /**
   * The handle last seen for each of these senders. Injected rather than reached for, because the
   * usernames live in the Channel's own tables and this component must not learn its schema.
   */
  readonly usernamesOf: (senderIds: readonly string[]) => Promise<Map<string, string>>;
};

export function createAnnouncements(options: AnnouncementsOptions) {
  const { db, users, messenger, agentServer, reachable, usernamesOf } = options;

  // Through `register`, so the routes exist by the time the OpenAPI document is built. Added
  // straight onto the instance they work but never appear in it, and the agent is told that document
  // is the truth about what it can call.
  agentServer.fastify.register(async (fastify) => {
    fastify.post(
      "/announce",
      {
        schema: {
          tags: ["Rounds"],
          summary: "Tell each keyper's operators something, expecting no reply",
          description:
            "Sends one message to each named keyper's own chat. **Each keyper gets its own text**, " +
            "so a per-keyper number — its uptime, its version, its sync status — goes to the " +
            "operators it concerns and nowhere else. To say the same thing to everybody, repeat it.\n\n" +
            "Nothing is waited for and nothing is recorded beyond the Messages. Use `POST /rounds` " +
            "instead when you need every operator to answer.\n\n" +
            "The answer names the keypers with no registered chat. They were **not** told, and nobody " +
            "else was told that they were not — say so in the group that asked, because a fan-out " +
            "that reached half the fleet otherwise looks exactly like one that reached all of it.\n\n" +
            "**Say it in words, never as a field name.** \"All five were told\", or \"kpr-x has " +
            "no chat, so its operators were not told\" -- never \"noChat empty\", which means " +
            "nothing to anybody but you.\n\n" +
            "Resolve the keyperset to its keypers yourself first, and say which chats you are about " +
            "to write to before you call this.\n\n" +
            "Each keyper's operators are @mentioned on a line above your text where their handle is " +
            "known. That is added for you — **do not write an @handle into `text` yourself**, and " +
            "do not ask anyone for one.",
          body: {
            type: "object",
            required: ["messages"],
            properties: {
              messages: {
                type: "array",
                minItems: 1,
                description: "One entry per keyper. A keyper named twice is written to twice.",
                items: {
                  type: "object",
                  required: ["keyper", "text"],
                  properties: {
                    keyper: { type: "string", description: "The Grafana `instance` label." },
                    text: { type: "string", description: "What that keyper's operators are told." },
                  },
                },
              },
            },
          },
        },
      },
      async (request, reply) => {
        const { messages } = (request.body ?? {}) as {
          messages?: { keyper?: string; text?: string }[];
        };
        if (!Array.isArray(messages) || messages.length === 0) {
          reply.code(400);
          return { error: "a non-empty messages array is wanted" };
        }
        if (messages.some((m) => !m.keyper || !m.text)) {
          reply.code(400);
          return { error: "every message needs a keyper and a text" };
        }

        const chats = await keyperChatsByKeyper(users, reachable);
        const going = messages.flatMap((m) =>
          (chats.get(m.keyper!) ?? []).map((chat) => ({ chat, text: m.text! })),
        );
        // One lookup for the whole fan-out, before the transaction opens: it is a read, and doing it
        // per chat would put a query per keyper inside the write that must not stop half way.
        const usernames = await usernamesOf(going.flatMap(({ chat }) => chat.operators));
        const noChat = messages.filter((m) => (chats.get(m.keyper!) ?? []).length === 0).map((m) => m.keyper!);
        if (going.length === 0) {
          reply.code(409);
          return { error: "none of those keypers has a registered chat", noChat };
        }

        // One transaction: either every chat is written to or none is, so a fan-out cannot stop
        // half way and leave nobody able to say how far it got.
        await db.tx(async (tx) => {
          for (const { chat, text } of going) {
            await messenger.send(tx, chat.userId, addressed(text, chat.operators, usernames));
          }
        });

        return { told: going.map(({ chat }) => chat.keyper), noChat };
      },
    );
  });

  return {
    async start() {},
    async stop() {},
  };
}

export type Announcements = ReturnType<typeof createAnnouncements>;
