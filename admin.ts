// Operator commands against the database. The gateway does not need to be running.
//
//   docker compose run --rm --no-deps gateway node admin.ts list
//   docker compose run --rm --no-deps gateway node admin.ts add <name> <chatId>
//   docker compose run --rm --no-deps gateway node admin.ts detach <userId>
//
// `add` creates the User, names them and attaches their Telegram chat in one transaction, so a
// User nobody can reach never exists. The chat id is what the Channel answers to a message from
// an unknown chat. `detach` removes the chat and nothing else: the framework removes no User,
// and their message log stays.

import { eq } from "drizzle-orm";
import { openDb } from "@shutter-network/concorde/db";
import { createUsers } from "@shutter-network/concorde/users";
import { insertChat } from "./telegram-channel/chats.ts";
import { chats, telegramChannelTables } from "./telegram-channel/schema/index.ts";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("DATABASE_URL is not set");

const db = openDb(databaseUrl);
const users = createUsers({ db });
const handle = db.handle(telegramChannelTables);
const [command, ...args] = process.argv.slice(2);

function usage(): never {
  console.error("usage: node admin.ts list | add <name> <chatId> | detach <userId>");
  process.exit(2);
}

try {
  switch (command) {
    case "list": {
      const chatOf = new Map((await handle.select().from(chats)).map((r) => [r.userId, r.chatId]));
      for (const user of await users.list()) {
        const name = (user.attributes as { name?: string } | null)?.name ?? "";
        console.log(`${user.id}  ${name.padEnd(24)}  chat ${chatOf.get(user.id) ?? "-"}`);
      }
      break;
    }
    case "add": {
      const [name, chatId] = args;
      if (name === undefined || chatId === undefined) usage();
      const id = await db.tx(async (tx) => {
        const user = await users.create(tx);
        await users.setAttributes(tx, user.id, { name });
        await insertChat(tx, user.id, chatId);
        return user.id;
      });
      console.log(`user ${id} (${name}) is reachable on chat ${chatId}`);
      break;
    }
    case "detach": {
      const [userId] = args;
      if (userId === undefined) usage();
      const removed = await handle
        .delete(chats)
        .where(eq(chats.userId, userId))
        .returning({ chatId: chats.chatId });
      console.log(
        removed.length > 0
          ? `user ${userId} is detached from chat ${removed[0].chatId}; their log stays`
          : `user ${userId} had no chat`,
      );
      break;
    }
    default:
      usage();
  }
} finally {
  await db.stop();
}
