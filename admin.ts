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
// A chat is either a **keyper chat**, covering one keyper and written in only by its operator, or a
// **teammate chat**, covering all and written in by teammates. Which it is, is written down rather
// than inferred: a teammate chat is the only one that may ask about every keyper at once, and a chat
// must not drift into holding that licence. `add-keyper-chat` and `add-teammate-chat` each create
// the User, name it, attach the chat and record the kind in one transaction, so a chat nobody can
// reach never exists.
//
// `remove-chat` removes the chat and nothing else: the framework removes no User, and their message
// log stays. It serves both kinds and names what it removed, so a mistyped id is visible in the
// output rather than silent.
//
// Telegram's posting permission decides who *may* write in a keyper room; `operators` records which
// sender id that human is, so the agent can be told whether an operator or a teammate wrote. The two
// are separate: the permission is enforced by Telegram, the record is kept here, and an operator who
// has not been recorded yet reads as a teammate until `add-operator` says otherwise.
//
// A group is addressed by its chat id everywhere, because whoever made the group has that and not
// the User's uuid. The bot tells an unregistered chat both ids it needs. `attach-chat` is the exception
// and takes the uuid, which `list-chats` prints last: it is what to reach for when the chat id is the
// thing that is wrong or missing, so there is no chat id to name the group by.
//
// A sender id cannot be invented, only observed: it arrives in the reply to an unregistered chat,
// or in `list-members` once that person has written to a registered one.

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
      // Telegram gives a group a negative id. Only a warning: the sign is a convention rather than
      // a documented guarantee, and the Channel refuses a private chat on its type anyway.
      if (!chatId.startsWith("-")) {
        console.warn(`warning: ${chatId} is positive, and a Telegram group's id is negative`);
      }
      // One chat per keyper, refused rather than warned about: two rooms covering one keyper means
      // two places its operators are written to and two places they answer from, and no way to say
      // which is the keyper's. Moving a keyper to another group keeps its log, its operators and
      // its history, and registering it again would strand all three on the first User.
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

    // Its own command rather than a flag, so the kind is written by whoever runs it and cannot be
    // arrived at by leaving an argument out.
    case "add-teammate-chat": {
      const [name, chatId] = args;
      if (name === undefined || chatId === undefined) usage();
      if (!chatId.startsWith("-")) {
        console.warn(`warning: ${chatId} is positive, and a Telegram group's id is negative`);
      }
      const existing = (await users.list()).filter((u) => attributesOf(u).kind === "teammate");
      // Not refused: nothing is aggregated, so a second teammate chat is harmless. Said out loud
      // because an unintended one would quietly hold the licence to ask every operator.
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
      // Says what it removed rather than only that it removed something: one command serves both
      // kinds, so naming the kind and the name is what makes a mistyped id visible afterwards.
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
