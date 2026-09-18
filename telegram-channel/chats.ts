import { eq } from "drizzle-orm";
import type { Handle } from "@shutter-network/concorde/db";
import { chats, type telegramChannelTables } from "./schema/index.ts";

type TelegramHandle = Handle<typeof telegramChannelTables>;

const uniqueViolation = "23505";
const foreignKeyViolation = "23503";

// Telegram chat ids are integers; a group's is negative.
const chatIdPattern = /^-?\d{1,20}$/;

export class MalformedChatIdError extends Error {
  constructor(chatId: string) {
    super(`${JSON.stringify(chatId)} is not a Telegram chat id: an integer, negative for a group, is wanted`);
    this.name = "MalformedChatIdError";
  }
}

export class NoSuchUserError extends Error {
  constructor(userId: string) {
    super(`no User ${userId} exists, so no Telegram chat can be recorded for them`);
    this.name = "NoSuchUserError";
  }
}

export class ChatConflictError extends Error {
  constructor(userId: string, chatId: string) {
    super(
      `chat ${chatId} cannot be recorded for User ${userId}: either that chat already belongs to another User or that User already has a chat, and neither is replaced here`,
    );
    this.name = "ChatConflictError";
  }
}

export async function insertChat<TSchema extends Record<string, unknown>>(
  handle: Handle<TSchema>,
  userId: string,
  chatId: string,
): Promise<void> {
  if (!chatIdPattern.test(chatId)) throw new MalformedChatIdError(chatId);
  try {
    // A savepoint, so a violation here does not poison the caller's transaction.
    await handle.transaction(async (savepoint) => {
      await savepoint.insert(chats).values({ userId, chatId });
    });
  } catch (error) {
    const code = sqlState(error);
    if (code === foreignKeyViolation) throw new NoSuchUserError(userId);
    if (code === uniqueViolation) throw new ChatConflictError(userId, chatId);
    throw error;
  }
}

export async function selectUserFor(
  handle: TelegramHandle,
  chatId: string,
): Promise<string | undefined> {
  const [row] = await handle
    .select({ userId: chats.userId })
    .from(chats)
    .where(eq(chats.chatId, chatId))
    .limit(1);
  return row?.userId;
}

export async function selectChatFor<TSchema extends Record<string, unknown>>(
  handle: Handle<TSchema>,
  userId: string,
): Promise<string | undefined> {
  const [row] = await handle
    .select({ chatId: chats.chatId })
    .from(chats)
    .where(eq(chats.userId, userId))
    .limit(1);
  return row?.chatId;
}

function sqlState(error: unknown): string | undefined {
  let unwrapped: unknown = error;
  while (unwrapped instanceof Error) {
    if ("code" in unwrapped && typeof unwrapped.code === "string") return unwrapped.code;
    unwrapped = unwrapped.cause;
  }
  return undefined;
}
