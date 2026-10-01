// Operator commands against the database. The gateway does not need to be running.
//
//   docker compose run --rm --no-deps gateway node admin.ts list-chats
//   docker compose run --rm --no-deps gateway node admin.ts add-keyper-chat <name> <chatId> <keyper> [operator]
//   docker compose run --rm --no-deps gateway node admin.ts add-teammate-chat <name> <chatId>
//   docker compose run --rm --no-deps gateway node admin.ts remove-chat <chatId>
//   docker compose run --rm --no-deps gateway node admin.ts attach-chat <userId> <chatId>
//   docker compose run --rm --no-deps gateway node admin.ts list-members <chatId>
//   docker compose run --rm --no-deps gateway node admin.ts add-operator <chatId> <senderId>
//   docker compose run --rm --no-deps gateway node admin.ts remove-operator <chatId> <senderId>
//
// A chat is either a **keyper chat**, covering one keyper, or a **teammate chat**, covering none.
// The kind is written down, never inferred. Only a teammate chat may ask about every keyper at once,
// and a chat must not drift into holding that. Both add commands create the User, name it, attach
// the chat and record the kind in one transaction, so a chat nobody can reach never exists.
//
// `remove-chat` removes the chat and nothing else. The framework removes no User and the message log
// stays. It names what it removed, so a mistyped id shows up in the output.
//
// Two separate things decide the operator. Telegram's posting permission decides who may write in a
// keyper room. `operators` records which sender id that human is, so the agent can be told whether
// an operator or a teammate wrote. An operator nobody has recorded yet reads as a teammate.
//
// Every command takes a chat id, because that is what whoever made the group has. `attach-chat` is
// the exception and takes the User's uuid, which `list-chats` prints last. You reach for it when the
// chat id is the broken thing, so there is no chat id to name the group by.
//
// A sender id cannot be invented, only observed. It arrives in the reply to an unregistered chat, or
// in `list-members` once that person has written somewhere registered.

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
  readonly kind?: "keyper" | "teammate";
  readonly name?: string;
  readonly keyper?: string;
  readonly operators?: readonly string[];
};

function usage(): never {
  console.error(
    "usage: node admin.ts list-chats\n" +
      "       node admin.ts add-keyper-chat <name> <chatId> <keyper> [operatorSenderId]\n" +
      "       node admin.ts add-teammate-chat <name> <chatId>\n" +
      "       node admin.ts remove-chat <chatId>\n" +
      "       node admin.ts attach-chat <userId> <chatId>\n" +
      "       node admin.ts list-members <chatId>\n" +
      "       node admin.ts add-operator <chatId> <senderId>\n" +
      "       node admin.ts remove-operator <chatId> <senderId>",
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

// `setAttributes` replaces the whole value, so every change reads first and writes it all back.
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
    case "list-chats": {
      const chatOf = new Map((await handle.select().from(chats)).map((r) => [r.userId, r.chatId]));
      for (const user of await users.list()) {
        const { kind = "?", name = "", keyper, operators = [] } = attributesOf(user);
        const covers = kind === "teammate" ? "teammates" : `keyper ${keyper ?? "(none bound)"}`;
        console.log(
          `${(chatOf.get(user.id) ?? "-").padEnd(16)}  ${kind.padEnd(8)}  ${name.padEnd(24)}  ${covers.padEnd(28)}  operators ${operators.join(",") || "-"}  ${user.id}`,
        );
      }
      break;
    }

    case "add-keyper-chat": {
      const [name, chatId, keyper, operator] = args;
      if (name === undefined || chatId === undefined || keyper === undefined) usage();
      // Telegram gives a group a negative id. Warn only: the sign is a convention, not a documented
      // guarantee, and the Channel refuses a private chat on its type anyway.
      if (!chatId.startsWith("-")) {
        console.warn(`warning: ${chatId} is positive, and a Telegram group's id is negative`);
      }
      // One chat per keyper, refused rather than warned about. Two rooms covering one keyper means
      // two places its operators are written to and two places they answer from, with no way to say
      // which is the keyper's. Move a keyper rather than registering it again: registering again
      // builds a new User and strands the first one's log, operators and history.
      const already = (await users.list()).filter((u) => {
        const a = attributesOf(u);
        return a.kind === "keyper" && a.keyper === keyper;
      });
      if (already.length > 0) {
        const [held] = already;
        console.error(
          `${keyper} already has a chat, held by user ${held.id} (${attributesOf(held).name ?? "unnamed"}); nothing was added.\n` +
            `To move it to another group:  remove-chat <its chat id>  then  attach-chat ${held.id} ${chatId}`,
        );
        process.exit(1);
      }
      const id = await db.tx(async (tx) => {
        const user = await users.create(tx);
        await users.setAttributes(tx, user.id, {
          kind: "keyper",
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

    // Its own command rather than a flag, so whoever runs it writes the kind down. Leaving an
    // argument out cannot produce one by accident.
    case "add-teammate-chat": {
      const [name, chatId] = args;
      if (name === undefined || chatId === undefined) usage();
      if (!chatId.startsWith("-")) {
        console.warn(`warning: ${chatId} is positive, and a Telegram group's id is negative`);
      }
      const existing = (await users.list()).filter((u) => attributesOf(u).kind === "teammate");
      // Not refused, because a second teammate chat is harmless. Warned about, because one nobody
      // meant to make could still ask every operator.
      if (existing.length > 0) {
        console.warn(`warning: ${existing.length} teammate chat(s) already exist`);
      }
      const id = await db.tx(async (tx) => {
        const user = await users.create(tx);
        await users.setAttributes(tx, user.id, { kind: "teammate", name });
        await insertChat(tx, user.id, chatId);
        return user.id;
      });
      console.log(`user ${id} (${name}) is a teammate chat on chat ${chatId}`);
      break;
    }

    case "list-members": {
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
      // "who is in this room" by omitting the one person most worth seeing. A reader is invisible
      // either way: Telegram only ever names a sender on a message.
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

    case "add-operator": {
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

    case "remove-operator": {
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
    // corrected the same way: `remove-chat`, then `attach-chat` with the right id. Adding a chat would
    // strand the log and the keyper on the first.
    case "attach-chat": {
      const [userId, chatId] = args;
      if (userId === undefined || chatId === undefined) usage();
      if (!chatId.startsWith("-")) {
        console.warn(`warning: ${chatId} is positive, and a Telegram group's id is negative`);
      }
      await db.tx((tx) => insertChat(tx, userId, chatId));
      console.log(`user ${userId} is reachable on chat ${chatId}`);
      break;
    }

    case "remove-chat": {
      const [chatId] = args;
      if (chatId === undefined) usage();
      const userId = await userFor(chatId);
      const { kind, name } = attributesOf((await users.get(userId))!);
      await handle.delete(chats).where(eq(chats.chatId, chatId));
      // Names what it removed, not just that it removed something. One command serves both kinds,
      // so printing the kind and the name is what makes a mistyped id visible.
      console.log(
        `${kind ?? "kindless"} chat ${chatId} (${name ?? "unnamed"}) is detached from user ${userId}; their log stays`,
      );
      break;
    }

    default:
      usage();
  }
} finally {
  await db.stop();
}
