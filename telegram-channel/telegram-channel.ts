// A Channel that carries Messages over the Telegram Bot API.
//
// Inbound: one long poll on getUpdates. A text from a chat some User holds becomes that User's
// Message, inside one transaction with the update id, so a redelivery is dropped. A text from a
// chat nobody holds is answered once with its own chat id, outside the log, which is how an
// operator learns the id to hand the team.
//
// Outbound: `send` writes an outbox row inside the Messenger's transaction and rings a NOTIFY.
// The drain then calls sendMessage after the commit, deletes the row on success, keeps it with a
// reason when Telegram refuses it for good, and leaves it for the next wake on anything transient.
// `send` itself never touches the network, which is what the Channel contract asks for.
//
// Modelled on `src/nostr-channel/` in shutter-network/concorde. Meant to move there.

import type { Db, Handle, Listening } from "@shutter-network/concorde/db";
import { type Logger, defaultLogger } from "@shutter-network/concorde/logging";
import type { Channel, MessageRecord, Messenger } from "@shutter-network/concorde/messenger";
import { insertChat, selectChatFor, selectUserFor } from "./chats.ts";
import {
  type OutboxRow,
  deleteSent,
  outboxChannel,
  queueText,
  recordRefusal,
  selectUnsent,
  UnrecordedChatError,
} from "./outbound.ts";
import { received, telegramChannelTables } from "./schema/index.ts";
import { createTelegramApi, TelegramApiError, type TelegramUpdate } from "./telegram-api.ts";

const channelName = "telegram";

export type TelegramChannelOptions = {
  readonly db: Db;
  readonly messenger: Messenger;
  /** The bot token from BotFather. */
  readonly token: string;
  readonly logger?: Logger;
  /** How long one getUpdates call waits for something to arrive. Default 25. */
  readonly pollTimeoutSeconds?: number;
  /** Pause after a failed poll before the next one. Default 5000. */
  readonly retryDelayMs?: number;
  /** For tests against a fake Bot API. */
  readonly apiBaseUrl?: string;
};

export type TelegramChannel = Channel & {
  /** Attach a chat to a User. Fails if either already has a partner. */
  recordChat<TSchema extends Record<string, unknown>>(
    tx: Handle<TSchema>,
    userId: string,
    chatId: string,
  ): Promise<void>;

  /** The chat a User is reached on, or undefined. */
  chatOf<TSchema extends Record<string, unknown>>(
    tx: Handle<TSchema>,
    userId: string,
  ): Promise<string | undefined>;

  /** Push whatever is queued to Telegram now. Tests call it; a deployment does not need to. */
  drain(): Promise<void>;
};

export function createTelegramChannel(options: TelegramChannelOptions): TelegramChannel {
  const handle = options.db.handle(telegramChannelTables);
  const log = options.logger ?? defaultLogger();
  const api = createTelegramApi(options.token, options.apiBaseUrl);
  const pollTimeout = options.pollTimeoutSeconds ?? 25;
  const retryDelay = options.retryDelayMs ?? 5000;

  let running: AbortController | undefined;
  let polling: Promise<void> = Promise.resolve();
  let listening: Listening | undefined;
  let draining: Promise<void> = Promise.resolve();
  let ticker: ReturnType<typeof setInterval> | undefined;

  async function admit(update: TelegramUpdate, signal: AbortSignal): Promise<void> {
    const message = update.message;
    const text = message?.text;
    // Edits, joins, stickers and photos carry no text and are not Messages.
    if (message === undefined || text === undefined) return;

    const chatId = String(message.chat.id);
    const userId = await selectUserFor(handle, chatId);
    if (userId === undefined) {
      log.info(
        { chatId, update: update.update_id },
        "a Telegram message came from a chat no User holds, and was dropped",
      );
      try {
        await api.sendMessage(
          chatId,
          `This chat is not registered with the agent. Its id is ${chatId}.`,
          signal,
        );
      } catch (error) {
        if (!signal.aborted) log.warn({ err: error, chatId }, "the reply to an unknown chat failed");
      }
      return;
    }

    const stored = await options.db.tx(async (tx) => {
      const [claimed] = await tx
        .insert(received)
        .values({ updateId: update.update_id })
        .onConflictDoNothing()
        .returning({ updateId: received.updateId });
      if (claimed === undefined) return false;
      await inbound.receive(tx, userId, text);
      return true;
    });
    if (stored) log.info({ update: update.update_id, userId }, "a Telegram message became a Message");
  }

  async function poll(signal: AbortSignal): Promise<void> {
    let offset: number | undefined;
    while (!signal.aborted) {
      try {
        const updates = await api.getUpdates(offset, pollTimeout, signal);
        for (const update of updates) {
          offset = update.update_id + 1;
          await admit(update, signal);
        }
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof TelegramApiError && error.code === 409) {
          log.error(
            { err: error },
            "another process is polling this bot token; stop it, because Telegram hands each update to one poller only",
          );
        } else {
          log.warn({ err: error }, "polling Telegram failed, and is retried");
        }
        await sleep(retryDelay, signal);
      }
    }
  }

  // True when the drain may continue to the next row.
  async function deliver(row: OutboxRow, signal: AbortSignal): Promise<boolean> {
    try {
      await api.sendMessage(row.chatId, row.text, signal);
    } catch (error) {
      if (signal.aborted) return false;
      if (error instanceof TelegramApiError && error.permanent) {
        await recordRefusal(handle, row.messageId, error.message);
        log.error(
          { message: row.messageId, userId: row.userId, reason: error.message },
          "Telegram refused a reply, and it is not being attempted again",
        );
        return true;
      }
      log.warn(
        { err: error, message: row.messageId },
        "sending a reply to Telegram failed, and it is retried at the next wake",
      );
      return false;
    }
    await deleteSent(handle, row.messageId);
    log.info({ message: row.messageId, userId: row.userId }, "a Message reached Telegram");
    return true;
  }

  async function drainOnce(): Promise<void> {
    const controller = running;
    if (controller === undefined) return;
    for (const row of await selectUnsent(handle)) {
      if (controller.signal.aborted) return;
      if (!(await deliver(row, controller.signal))) return;
    }
  }

  // One drain at a time; a wake during a drain queues one more behind it.
  function drain(): Promise<void> {
    const mine = draining.then(
      () => drainOnce(),
      () => drainOnce(),
    );
    draining = mine.catch(() => {});
    return mine;
  }

  function wakeDrain(why: string): void {
    void drain().catch((error) => {
      log.error(
        { err: error, why },
        "the Telegram Channel's outbound drain stopped short, and retries when next woken",
      );
    });
  }

  const channel: TelegramChannel = {
    name: channelName,
    recordChat: (tx, userId, chatId) => insertChat(tx, userId, chatId),
    chatOf: (tx, userId) => selectChatFor(tx, userId),
    send: async (tx, message: MessageRecord) => {
      const chatId = await selectChatFor(tx, message.userId);
      if (chatId === undefined) throw new UnrecordedChatError(message.userId);
      await queueText(tx, {
        messageId: message.id,
        userId: message.userId,
        chatId,
        text: message.text,
      });
    },
    drain,
    async start() {
      if (running !== undefined) return;
      const controller = new AbortController();
      running = controller;
      polling = poll(controller.signal);
      listening = options.db.listen(outboxChannel, {
        notified: () => wakeDrain("notification"),
        connected: () => wakeDrain("listening"),
        lost: (error) =>
          log.warn(
            { err: error, channel: outboxChannel },
            "the Telegram Channel's outbound notifications dropped; reconnecting, and a queued reply waits until they are back",
          ),
      });
      // A safety net for a reply left behind by a transient failure.
      ticker = setInterval(() => wakeDrain("timer"), 15_000);
    },
    async stop() {
      const controller = running;
      running = undefined;
      controller?.abort();
      if (ticker !== undefined) {
        clearInterval(ticker);
        ticker = undefined;
      }
      if (listening !== undefined) {
        await listening.close();
        listening = undefined;
      }
      await polling;
      polling = Promise.resolve();
      await draining;
      draining = Promise.resolve();
    },
  };

  const inbound = options.messenger.register(channel);
  return channel;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
