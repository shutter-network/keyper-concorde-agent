// Operator commands against the database. The gateway does not need to be running.
//
//   docker compose run --rm --no-deps gateway node admin.ts list
//   docker compose run --rm --no-deps gateway node admin.ts add <name> <chatId> <keyper> [operator]
//   docker compose run --rm --no-deps gateway node admin.ts members <chatId>
//   docker compose run --rm --no-deps gateway node admin.ts operator-add <chatId> <senderId>
//   docker compose run --rm --no-deps gateway node admin.ts operator-remove <chatId> <senderId>
//   docker compose run --rm --no-deps gateway node admin.ts attach <userId> <chatId>
//   docker compose run --rm --no-deps gateway node admin.ts detach <chatId>
//
// One Telegram group is one User is one keyper. `add` creates the User, names it, binds its keyper
// and attaches the chat in one transaction, so a group nobody can reach never exists. `detach`
// removes the chat and nothing else: the framework removes no User, and their message log stays.
//
// A group is addressed by its chat id everywhere, because whoever made the group has that and not
// the User's uuid. The bot tells an unregistered chat both ids it needs. `attach` is the exception
// and takes the uuid, which `list` prints last: it is what to reach for when the chat id is the
// thing that is wrong or missing, so there is no chat id to name the group by.
//
// A sender id cannot be invented, only observed: it arrives in the reply to an unregistered chat,
// or in `members` once that person has written to a registered one.

import { eq } from "drizzle-orm";
import { openDb } from "@shutter-network/concorde/db";
import { createUsers } from "@shutter-network/concorde/users";
import { insertChat } from "./telegram-channel/chats.ts";
import { chats, senders, telegramChannelTables } from "./telegram-channel/schema/index.ts";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("DATABASE_URL is not set");

const db = openDb(databaseUrl);
const users = createUsers({ db });
const handle = db.handle(telegramChannelTables);
const [command, ...args] = process.argv.slice(2);

type GroupAttributes = {
  readonly name?: string;
  readonly keyper?: string;
  readonly operators?: readonly string[];
};

function usage(): never {
  console.error(
    "usage: node admin.ts list\n" +
      "       node admin.ts add <name> <chatId> <keyper> [operatorSenderId]\n" +
      "       node admin.ts members <chatId>\n" +
      "       node admin.ts operator-add <chatId> <senderId>\n" +
      "       node admin.ts operator-remove <chatId> <senderId>\n" +
      "       node admin.ts attach <userId> <chatId>\n" +
      "       node admin.ts detach <chatId>",
  );
  process.exit(2);
}

async function userFor(chatId: string): Promise<string> {
  const [row] = await handle
    .select({ userId: chats.userId })
    .from(chats)
    .where(eq(chats.chatId, chatId))
    .limit(1);
  if (row === undefined) {
    console.error(`no group is registered on chat ${chatId}`);
    process.exit(1);
  }
  return row.userId;
}

function attributesOf(user: { attributes: unknown }): GroupAttributes {
  return (user.attributes ?? {}) as GroupAttributes;
}

// `setAttributes` replaces wholesale, so every change reads first and writes the whole shape back.
async function amendAttributes(
  userId: string,
  amend: (current: GroupAttributes) => GroupAttributes,
): Promise<GroupAttributes> {
  const user = await users.get(userId);
  if (user === undefined) throw new Error(`no User ${userId} exists`);
  const next = amend(attributesOf(user));
  await db.tx((tx) => users.setAttributes(tx, userId, next));
  return next;
}

try {
  switch (command) {
    case "list": {
      const chatOf = new Map((await handle.select().from(chats)).map((r) => [r.userId, r.chatId]));
      for (const user of await users.list()) {
        const { name = "", keyper = "-", operators = [] } = attributesOf(user);
        console.log(
          `${(chatOf.get(user.id) ?? "-").padEnd(16)}  ${name.padEnd(24)}  keyper ${keyper.padEnd(16)}  operators ${operators.join(",") || "-"}  ${user.id}`,
        );
      }
      break;
    }

    case "add": {
      const [name, chatId, keyper, operator] = args;
      if (name === undefined || chatId === undefined || keyper === undefined) usage();
      // Telegram gives a group a negative id. Only a warning: the sign is a convention rather than
      // a documented guarantee, and the Channel refuses a private chat on its type anyway.
      if (!chatId.startsWith("-")) {
        console.warn(`warning: ${chatId} is positive, and a Telegram group's id is negative`);
      }
      const id = await db.tx(async (tx) => {
        const user = await users.create(tx);
        await users.setAttributes(tx, user.id, {
          name,
          keyper,
          operators: operator === undefined ? [] : [operator],
        });
        await insertChat(tx, user.id, chatId);
        return user.id;
      });
      console.log(`user ${id} (${name}) covers keyper ${keyper} on chat ${chatId}`);
      if (operator !== undefined) console.log(`operator ${operator} recorded`);
      break;
    }

    case "members": {
      const [chatId] = args;
      if (chatId === undefined) usage();
      const userId = await userFor(chatId);
      const { operators = [] } = attributesOf((await users.get(userId))!);
      const rows = await handle
        .select()
        .from(senders)
        .where(eq(senders.chatId, chatId))
        .orderBy(senders.recordedAt);
      // Everyone who has written, latest word on each, and then the operators who have not. An
      // operator is recorded by hand and may never have written, and leaving them out would answer
      // "who is in this group" by omitting the one person most worth seeing.
      const latest = new Map(rows.map((r) => [r.senderId ?? "-", r]));
      if (latest.size === 0 && operators.length === 0) {
        console.log(`nobody has written to chat ${chatId} yet, and no operator is recorded`);
      }
      for (const [senderId, row] of latest) {
        const role = operators.includes(senderId) ? "operator" : "teammate";
        console.log(
          `${senderId.padEnd(16)}  ${(row.username === null ? (row.firstName ?? "-") : `@${row.username}`).padEnd(24)}  ${role.padEnd(10)}  last wrote ${row.recordedAt.toISOString()}`,
        );
      }
      for (const senderId of operators.filter((one) => !latest.has(one))) {
        console.log(`${senderId.padEnd(16)}  ${"-".padEnd(24)}  ${"operator".padEnd(10)}  has not written here`);
      }
      break;
    }

    case "operator-add": {
      const [chatId, senderId] = args;
      if (chatId === undefined || senderId === undefined) usage();
      const userId = await userFor(chatId);
      const [seen] = await handle
        .select({ senderId: senders.senderId })
        .from(senders)
        .where(eq(senders.senderId, senderId))
        .limit(1);
      if (seen === undefined) {
        console.warn(`warning: ${senderId} has never written here; recording them anyway`);
      }
      const next = await amendAttributes(userId, (current) => ({
        ...current,
        operators: [...new Set([...(current.operators ?? []), senderId])],
      }));
      console.log(`operators of chat ${chatId} are now ${next.operators?.join(",") || "-"}`);
      break;
    }

    case "operator-remove": {
      const [chatId, senderId] = args;
      if (chatId === undefined || senderId === undefined) usage();
      const userId = await userFor(chatId);
      const next = await amendAttributes(userId, (current) => ({
        ...current,
        operators: (current.operators ?? []).filter((one) => one !== senderId),
      }));
      console.log(`operators of chat ${chatId} are now ${next.operators?.join(",") || "-"}`);
      break;
    }

    // Telegram changes a group's id when it upgrades a basic group to a supergroup, and a typo is
    // corrected the same way: detach, then attach the right id. `add` would build a second User and
    // strand the log, the keyper and the operators on the first.
    case "attach": {
      const [userId, chatId] = args;
      if (userId === undefined || chatId === undefined) usage();
      if (!chatId.startsWith("-")) {
        console.warn(`warning: ${chatId} is positive, and a Telegram group's id is negative`);
      }
      await db.tx((tx) => insertChat(tx, userId, chatId));
      console.log(`user ${userId} is reachable on chat ${chatId}`);
      break;
    }

    case "detach": {
      const [chatId] = args;
      if (chatId === undefined) usage();
      const removed = await handle
        .delete(chats)
        .where(eq(chats.chatId, chatId))
        .returning({ userId: chats.userId });
      console.log(
        removed.length > 0
          ? `user ${removed[0].userId} is detached from chat ${chatId}; their log stays`
          : `no group is registered on chat ${chatId}`,
      );
      break;
    }

    default:
      usage();
  }
} finally {
  await db.stop();
}
