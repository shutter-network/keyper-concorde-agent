import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import Fastify from "fastify";
import type { Db } from "@shutter-network/concorde/db";
import { serverComponent } from "@shutter-network/concorde/gateway";
import { createMessenger, type Messenger } from "@shutter-network/concorde/messenger";
import * as messengerSchema from "@shutter-network/concorde/messenger/schema";
import { createSignalWorker, type Runtime } from "@shutter-network/concorde/signals";
import * as signalsSchema from "@shutter-network/concorde/signals/schema";
import { createUsers } from "@shutter-network/concorde/users";
import * as usersSchema from "@shutter-network/concorde/users/schema";
import { ChatConflictError, MalformedChatIdError, NoSuchUserError } from "./chats.ts";
import { type FakeBotApi, startFakeBotApi } from "./fake-bot-api.ts";
import { UnrecordedChatError } from "./outbound.ts";
import * as telegramChannelSchema from "./schema/index.ts";
import { outbox, telegramChannelTables } from "./schema/index.ts";
import type { TelegramUpdate } from "./telegram-api.ts";
import { createTelegramChannel, type TelegramChannel } from "./telegram-channel.ts";
import {
  applySchema,
  createTestDatabase,
  silent,
  sleep,
  type TestDatabase,
  waitUntil,
} from "./test-support.ts";

const nowhere = { port: 0, host: "127.0.0.1" } as const;
const token = "000000:TEST";

let database: TestDatabase;
let db: Db;
let users: ReturnType<typeof createUsers>;
let worker: ReturnType<typeof createSignalWorker>;

// Chats and update ids are unique across the file, because the `received` table is shared.
let nextChat = 1000;
let nextUpdate = 1;
const newChatId = (): string => String(nextChat++);
const textUpdate = (chatId: string, text: string, id: number = nextUpdate++): TelegramUpdate => ({
  update_id: id,
  message: { message_id: id, text, chat: { id: Number(chatId), type: "private" } },
});

before(async () => {
  database = await createTestDatabase("keyper_telegram_channel");
  db = database.db;
  await applySchema(db, signalsSchema, usersSchema, messengerSchema, telegramChannelSchema);
  users = createUsers({ db });
  const runtime: Runtime = { run: async () => ({ ok: true }) };
  worker = createSignalWorker({ db, runtime, handlers: {}, logger: silent });
});

after(() => database.drop());

type Deployment = {
  readonly api: FakeBotApi;
  readonly messenger: Messenger;
  readonly channel: TelegramChannel;
};

function deploymentFor(api: FakeBotApi, retryDelayMs = 50): Deployment {
  const messenger = createMessenger({
    db,
    users,
    worker,
    agentServer: serverComponent(Fastify(), nowhere),
  });
  const channel = createTelegramChannel({
    db,
    messenger,
    token,
    apiBaseUrl: api.url,
    logger: silent,
    pollTimeoutSeconds: 1,
    retryDelayMs,
  });
  return { api, messenger, channel };
}

async function withDeployment(
  body: (deployment: Deployment) => Promise<void>,
  options: { readonly retryDelayMs?: number; readonly beforeStart?: (api: FakeBotApi) => void } = {},
): Promise<void> {
  const api = await startFakeBotApi();
  options.beforeStart?.(api);
  const deployment = deploymentFor(api, options.retryDelayMs);
  await deployment.channel.start();
  try {
    await body(deployment);
  } finally {
    await deployment.channel.stop();
    await api.stop();
  }
}

type Recorded = { readonly userId: string; readonly chatId: string };

async function admit(channel: TelegramChannel): Promise<Recorded> {
  const chatId = newChatId();
  const userId = await db.tx(async (tx) => {
    const user = await users.create(tx);
    await channel.recordChat(tx, user.id, chatId);
    return user.id;
  });
  return { userId, chatId };
}

const outboxRows = (userId: string) =>
  db.handle(telegramChannelTables).select().from(outbox).where(eq(outbox.userId, userId));

const sentTo = (api: FakeBotApi, chatId: string) => api.sent.filter((m) => m.chatId === chatId);

describe("recording chats", () => {
  it("maps a chat to a User and back", async () => {
    const api = await startFakeBotApi();
    try {
      const { channel } = deploymentFor(api);
      const { userId, chatId } = await admit(channel);
      assert.equal(await db.tx((tx) => channel.chatOf(tx, userId)), chatId);
    } finally {
      await api.stop();
    }
  });

  it("refuses a chat that already belongs to another User", async () => {
    const api = await startFakeBotApi();
    try {
      const { channel } = deploymentFor(api);
      const { chatId } = await admit(channel);
      await assert.rejects(
        db.tx(async (tx) => {
          const other = await users.create(tx);
          await channel.recordChat(tx, other.id, chatId);
        }),
        ChatConflictError,
      );
    } finally {
      await api.stop();
    }
  });

  it("refuses a second chat for the same User", async () => {
    const api = await startFakeBotApi();
    try {
      const { channel } = deploymentFor(api);
      const { userId } = await admit(channel);
      await assert.rejects(
        db.tx((tx) => channel.recordChat(tx, userId, newChatId())),
        ChatConflictError,
      );
    } finally {
      await api.stop();
    }
  });

  it("refuses a malformed chat id and a User that does not exist", async () => {
    const api = await startFakeBotApi();
    try {
      const { channel } = deploymentFor(api);
      const userId = await db.tx(async (tx) => (await users.create(tx)).id);
      await assert.rejects(db.tx((tx) => channel.recordChat(tx, userId, "abc")), MalformedChatIdError);
      await assert.rejects(
        db.tx((tx) => channel.recordChat(tx, randomUUID(), newChatId())),
        NoSuchUserError,
      );
    } finally {
      await api.stop();
    }
  });
});

describe("inbound", () => {
  it("a text from a recorded chat becomes that User's inbound Message", async () => {
    await withDeployment(async ({ api, messenger, channel }) => {
      const { userId, chatId } = await admit(channel);
      api.push(textUpdate(chatId, "hello from telegram"));
      await waitUntil("the Message is in the log", async () => {
        return (await messenger.history(userId)).length === 1;
      });
      const [message] = await messenger.history(userId);
      assert.equal(message.direction, "inbound");
      assert.equal(message.text, "hello from telegram");
    });
  });

  it("a redelivered update does not become a second Message", async () => {
    await withDeployment(async ({ api, messenger, channel }) => {
      const { userId, chatId } = await admit(channel);
      const first = textUpdate(chatId, "once");
      api.push(first);
      await waitUntil("the first Message arrived", async () => {
        return (await messenger.history(userId)).length === 1;
      });
      api.push(first);
      api.push(textUpdate(chatId, "twice"));
      await waitUntil("the second text arrived", async () => {
        return (await messenger.history(userId)).some((m) => m.text === "twice");
      });
      assert.deepEqual(
        (await messenger.history(userId)).map((m) => m.text),
        ["once", "twice"],
      );
    });
  });

  it("a text from an unknown chat is answered with its own id and recorded nowhere", async () => {
    await withDeployment(async ({ api }) => {
      const strangerChat = newChatId();
      api.push(textUpdate(strangerChat, "who are you"));
      await waitUntil("the stranger got an answer", () => sentTo(api, strangerChat).length === 1);
      assert.match(sentTo(api, strangerChat)[0].text, new RegExp(strangerChat));
      const rows = await db.handle(telegramChannelTables).select().from(outbox);
      assert.equal(rows.some((r) => r.chatId === strangerChat), false);
    });
  });

  it("an update without text is ignored", async () => {
    await withDeployment(async ({ api, messenger, channel }) => {
      const { userId, chatId } = await admit(channel);
      const id = nextUpdate++;
      api.push({ update_id: id, message: { message_id: id, chat: { id: Number(chatId), type: "private" } } });
      api.push(textUpdate(chatId, "with text"));
      await waitUntil("the text arrived", async () => {
        return (await messenger.history(userId)).length >= 1;
      });
      assert.deepEqual((await messenger.history(userId)).map((m) => m.text), ["with text"]);
    });
  });
});

describe("outbound", () => {
  it("a Message to a User reaches their chat and leaves the outbox", async () => {
    await withDeployment(async ({ api, messenger, channel }) => {
      const { userId, chatId } = await admit(channel);
      await db.tx((tx) => messenger.send(tx, userId, "hello from the agent"));
      await waitUntil("Telegram received it", () => sentTo(api, chatId).length === 1);
      assert.equal(sentTo(api, chatId)[0].text, "hello from the agent");
      await waitUntil("the outbox is empty", async () => (await outboxRows(userId)).length === 0);
    });
  });

  it("a Message to a User with no chat is refused and nothing is written", async () => {
    await withDeployment(async ({ messenger }) => {
      const userId = await db.tx(async (tx) => (await users.create(tx)).id);
      await assert.rejects(db.tx((tx) => messenger.send(tx, userId, "nowhere")), UnrecordedChatError);
      assert.deepEqual(await messenger.history(userId), []);
      assert.deepEqual(await outboxRows(userId), []);
    });
  });

  it("a reply Telegram refuses for good is kept with the reason", async () => {
    await withDeployment(async ({ api, messenger, channel }) => {
      const { userId, chatId } = await admit(channel);
      api.refuse(chatId, { code: 403, description: "Forbidden: bot was blocked by the user" });
      await db.tx((tx) => messenger.send(tx, userId, "are you there"));
      await waitUntil("the refusal is recorded", async () => {
        const [row] = await outboxRows(userId);
        return row !== undefined && row.reason !== null;
      });
      const [row] = await outboxRows(userId);
      assert.match(row.reason ?? "", /403/);
      assert.notEqual(row.failedAt, null);
      assert.equal(sentTo(api, chatId).length, 0);
    });
  });

  it("a transient failure leaves the reply for the next drain", async () => {
    await withDeployment(async ({ api, messenger, channel }) => {
      const { userId, chatId } = await admit(channel);
      api.refuse(chatId, { code: 500, description: "Internal Server Error" });
      await db.tx((tx) => messenger.send(tx, userId, "try again"));
      await waitUntil("one attempt was refused", () => api.refused.length >= 1);
      const [row] = await outboxRows(userId);
      assert.equal(row.reason, null);
      api.refuse(chatId, undefined);
      await channel.drain();
      await waitUntil("Telegram received it", () => sentTo(api, chatId).length === 1);
      await waitUntil("the outbox is empty", async () => (await outboxRows(userId)).length === 0);
    });
  });

  it("a long reply is split at 4096 characters", async () => {
    await withDeployment(async ({ api, messenger, channel }) => {
      const { userId, chatId } = await admit(channel);
      const text = "a".repeat(5000);
      await db.tx((tx) => messenger.send(tx, userId, text));
      await waitUntil("both parts arrived", () => sentTo(api, chatId).length === 2);
      const parts = sentTo(api, chatId).map((m) => m.text);
      assert.deepEqual(parts.map((p) => p.length), [4096, 904]);
      assert.equal(parts.join(""), text);
    });
  });

  it("a reply queued while stopped goes out at the next start", async () => {
    const api = await startFakeBotApi();
    const { messenger, channel } = deploymentFor(api);
    try {
      const { userId, chatId } = await admit(channel);
      await db.tx((tx) => messenger.send(tx, userId, "queued while down"));
      assert.equal((await outboxRows(userId)).length, 1);
      assert.equal(sentTo(api, chatId).length, 0);
      await channel.start();
      await waitUntil("Telegram received it after start", () => sentTo(api, chatId).length === 1);
      await waitUntil("the outbox is empty", async () => (await outboxRows(userId)).length === 0);
    } finally {
      await channel.stop();
      await api.stop();
    }
  });
});

describe("polling", () => {
  it("survives a 409 from another poller and resumes when it is gone", async () => {
    await withDeployment(
      async ({ api, messenger, channel }) => {
        const { userId, chatId } = await admit(channel);
        await sleep(100);
        assert.deepEqual(await messenger.history(userId), []);
        api.failPolls(undefined);
        api.push(textUpdate(chatId, "after the conflict"));
        await waitUntil("the Message arrived once polling resumed", async () => {
          return (await messenger.history(userId)).length === 1;
        });
      },
      {
        retryDelayMs: 20,
        beforeStart: (api) =>
          api.failPolls({ code: 409, description: "Conflict: terminated by other getUpdates request" }),
      },
    );
  });

  it("stop ends the poll and start resumes it", async () => {
    const api = await startFakeBotApi();
    const { messenger, channel } = deploymentFor(api);
    try {
      const { userId, chatId } = await admit(channel);
      await channel.start();
      await channel.stop();
      api.push(textUpdate(chatId, "while stopped"));
      await sleep(100);
      assert.deepEqual(await messenger.history(userId), []);
      await channel.start();
      await waitUntil("the Message arrived after restart", async () => {
        return (await messenger.history(userId)).length === 1;
      });
    } finally {
      await channel.stop();
      await api.stop();
    }
  });
});
