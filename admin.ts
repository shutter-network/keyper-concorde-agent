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
// A keyper chat is assigned to one keyper. A teammate chat is for the team and has no keyper.
// Store the chat kind explicitly because only teammate chats may request actions for all keypers.
// Both add commands create the User, set its name and kind, and link its Telegram chat in one
// transaction. This prevents partially registered groups that cannot receive messages.
//
// `remove-chat` deletes only the link to the Telegram chat. It keeps the User and message history.
// The output identifies the removed chat so the administrator can spot an incorrect ID.
//
// Telegram posting permissions control who can write in a keyper group. The `operators` list
// records their sender IDs so the agent can distinguish operators from teammates.
// An operator is labeled as a teammate until their sender ID is recorded.
//
// Commands that identify an existing group use its Telegram chat ID, which the group creator knows.
// `attach-chat` also takes the User UUID shown at the end of `list-chats` output. This lets an
// administrator attach the correct chat when the old chat ID is wrong or no longer valid.
//
// Use a sender ID observed in Telegram; do not invent one. The reply to an unregistered chat
// includes it. After the person writes in a registered chat, it also appears in `list-members`.

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

// `setAttributes` replaces all attributes. Read the current values first so unrelated fields are kept.
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
      // Telegram group IDs are normally negative, but this is not a documented guarantee.
      // Only warn here; the Channel separately rejects private chats based on their chat type.
      if (!chatId.startsWith("-")) {
        console.warn(`warning: ${chatId} is positive, and a Telegram group's id is negative`);
      }
      // Reject a second chat for the same keyper. Otherwise, messages and replies could be split
      // between two groups with no clear choice of which group to use. To move a keyper, attach
      // the new chat to the existing User. Registering again creates a new User and leaves the
      // message history and operator records attached to the old one.
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

    // Use a separate command so the administrator explicitly chooses a teammate chat.
    // Omitting an argument from another command must not create one accidentally.
    case "add-teammate-chat": {
      const [name, chatId] = args;
      if (name === undefined || chatId === undefined) usage();
      if (!chatId.startsWith("-")) {
        console.warn(`warning: ${chatId} is positive, and a Telegram group's id is negative`);
      }
      const existing = (await users.list()).filter((u) => attributesOf(u).kind === "teammate");
      // Allow multiple teammate chats, but warn about existing ones. An accidentally created
      // teammate chat would still have permission to contact every operator.
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
      // List each sender using their most recent record, then include registered operators who
      // have never posted. Operators are added manually, so message records alone may omit them.
      // Other members who only read messages cannot be listed because Telegram provides sender
      // details only when someone posts.
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

    // To fix a chat ID or update it after Telegram upgrades a group to a supergroup, run
    // `remove-chat`, then `attach-chat` with the correct ID. This keeps the existing User,
    // message history and keyper assignment together.
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
      // Print the chat kind and name so the administrator can spot an incorrect ID.
      // This command handles both keyper and teammate chats.
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
