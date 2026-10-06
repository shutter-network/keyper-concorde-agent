// Operator commands against the database. The gateway does not need to be running.
//
//   docker compose run --rm --no-deps gateway node admin.ts list-chats
//   docker compose run --rm --no-deps gateway node admin.ts add-keyper-chat <name> <chatId> <instance>:<set> ... [--operator <id>[,<id>...]]
//   docker compose run --rm --no-deps gateway node admin.ts add-keypers <chatId> <instance>:<set> ...
//   docker compose run --rm --no-deps gateway node admin.ts remove-keypers <chatId>
//   docker compose run --rm --no-deps gateway node admin.ts add-teammate-chat <name> <chatId>
//   docker compose run --rm --no-deps gateway node admin.ts remove-chat <chatId>
//   docker compose run --rm --no-deps gateway node admin.ts attach-chat <userId> <chatId>
//   docker compose run --rm --no-deps gateway node admin.ts list-members <chatId>
//   docker compose run --rm --no-deps gateway node admin.ts add-operator <chatId> <senderId>
//   docker compose run --rm --no-deps gateway node admin.ts remove-operator <chatId> <senderId>
//
// A keyper chat covers a set of keypers and holds the operators who run them, of whom there may be
// several. A teammate chat is for the team and covers none. Store the chat kind explicitly because only teammate chats may request actions for all
// keypers.
//
// A keyper is identified by `(instance, set)`, the same pair the metrics and logs use: one machine
// taking part in one keyperset. A machine in two keypersets is two entries, and the pair is what
// must not be held by two groups. The same instance in two groups under different sets is allowed
// but warned about, because a machine is normally run by one group in every set it joins.
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
import { type KeyperRef, type KeyperSet, keyperSets } from "./prompt.ts";
import { chats, senders, telegramChannelTables } from "./telegram-channel/schema/index.ts";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("DATABASE_URL is not set");

const db = openDb(databaseUrl);
const users = createUsers({ db });
const handle = db.handle(telegramChannelTables);
const [command, ...args] = process.argv.slice(2);

// `keyperSets` comes from prompt.ts so the list the agent is told about and the list this command
// accepts cannot drift apart. A value outside it is refused rather than stored.
type GroupAttributes = {
  readonly kind?: "keyper" | "teammate";
  readonly name?: string;
  readonly keypers?: readonly KeyperRef[];
  readonly operators?: readonly string[];
};

const isKeyperSet = (value: string): value is KeyperSet =>
  (keyperSets as readonly string[]).includes(value);

const describePair = (keyper: KeyperRef): string => `${keyper.instance}/${keyper.set}`;

/** One entry per machine, so a machine in two keypersets reads as one thing rather than two. */
function describeKeypers(keypers: readonly KeyperRef[]): string {
  if (keypers.length === 0) return "(none bound)";
  const sets = new Map<string, string[]>();
  for (const { instance, set } of keypers) {
    sets.set(instance, [...(sets.get(instance) ?? []), set]);
  }
  return [...sets].map(([instance, its]) => `${instance}[${its.join(",")}]`).join(" ");
}

function keypersOf(user: { attributes: unknown }): readonly KeyperRef[] {
  const { keypers } = attributesOf(user);
  return Array.isArray(keypers) ? keypers : [];
}

/** `kpr-example:api` into a pair. Rejects an unknown keyperset, so a typo cannot be stored. */
function parsePairs(raw: readonly string[]): KeyperRef[] {
  if (raw.length === 0) usage();
  const parsed: KeyperRef[] = [];
  for (const arg of raw) {
    // Split on the last colon: an instance name may contain one, a keyperset never does.
    const at = arg.lastIndexOf(":");
    if (at <= 0 || at === arg.length - 1) {
      console.error(`"${arg}" is not <instance>:<set>`);
      process.exit(1);
    }
    const instance = arg.slice(0, at);
    const set = arg.slice(at + 1);
    if (!isKeyperSet(set)) {
      console.error(`"${set}" is not a keyperset; use ${keyperSets.join(" or ")}`);
      process.exit(1);
    }
    if (parsed.some((one) => one.instance === instance && one.set === set)) {
      console.error(`${instance}/${set} is listed twice`);
      process.exit(1);
    }
    parsed.push({ instance, set });
  }
  return parsed;
}

/**
 * Refuses a pair another group already holds, because messages and replies would then be split
 * between two groups with no clear choice of which to use. Warns, but allows, the same instance in
 * another group under a different keyperset: the operator is normally the same for every set a
 * machine joins, so that is worth seeing when it happens rather than forbidding.
 */
async function assertAssignable(pairs: readonly KeyperRef[], selfUserId?: string): Promise<void> {
  const others = (await users.list()).filter(
    (one) => one.id !== selfUserId && attributesOf(one).kind === "keyper",
  );
  for (const pair of pairs) {
    for (const other of others) {
      const name = attributesOf(other).name ?? "unnamed";
      const held = keypersOf(other);
      if (held.some((one) => one.instance === pair.instance && one.set === pair.set)) {
        console.error(
          `${describePair(pair)} is already held by user ${other.id} (${name}); nothing was changed.\n` +
            `To move it, run remove-keypers on that group's chat, then add-keypers the ones that stay.`,
        );
        process.exit(1);
      }
      if (held.some((one) => one.instance === pair.instance)) {
        console.warn(
          `warning: ${pair.instance} is also held by user ${other.id} (${name}) in another keyperset`,
        );
      }
    }
  }
}

/** Pulls `--name value` out of the arguments, so the pair list can stay variadic and last. */
function takeOption(argv: readonly string[], option: string): { value?: string; rest: string[] } {
  const at = argv.indexOf(option);
  if (at === -1) return { rest: [...argv] };
  const value = argv[at + 1];
  if (value === undefined) usage();
  return { value, rest: [...argv.slice(0, at), ...argv.slice(at + 2)] };
}

function usage(): never {
  console.error(
    "usage: node admin.ts list-chats\n" +
      "       node admin.ts add-keyper-chat <name> <chatId> <instance>:<set> ... [--operator <id>[,<id>...]]\n" +
      "       node admin.ts add-keypers <chatId> <instance>:<set> ...\n" +
      "       node admin.ts remove-keypers <chatId>\n" +
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
        const { kind = "?", name = "", operators = [] } = attributesOf(user);
        const covers = kind === "teammate" ? "teammates" : describeKeypers(keypersOf(user));
        console.log(
          `${(chatOf.get(user.id) ?? "-").padEnd(16)}  ${kind.padEnd(8)}  ${name.padEnd(24)}  ${covers.padEnd(28)}  operators ${operators.join(",") || "-"}  ${user.id}`,
        );
      }
      break;
    }

    // `name` names the operators, not a keyper: one group covers every keyper they run between them.
    // The keyper list is variadic and last, so the operator is given as an option rather than a
    // trailing argument, which would be indistinguishable from another keyper.
    case "add-keyper-chat": {
      const { value: given, rest } = takeOption(args, "--operator");
      const [name, chatId, ...pairArgs] = rest;
      if (name === undefined || chatId === undefined) usage();
      // A group may have several operators, so `--operator` takes a comma-separated list.
      const operators = [
        ...new Set(
          (given ?? "")
            .split(",")
            .map((one) => one.trim())
            .filter((one) => one !== ""),
        ),
      ];
      // Telegram group IDs are normally negative, but this is not a documented guarantee.
      // Only warn here; the Channel separately rejects private chats based on their chat type.
      if (!chatId.startsWith("-")) {
        console.warn(`warning: ${chatId} is positive, and a Telegram group's id is negative`);
      }
      const keypers = parsePairs(pairArgs);
      await assertAssignable(keypers);
      const id = await db.tx(async (tx) => {
        const user = await users.create(tx);
        await users.setAttributes(tx, user.id, {
          kind: "keyper",
          name,
          keypers,
          operators,
        });
        await insertChat(tx, user.id, chatId);
        return user.id;
      });
      console.log(`user ${id} (${name}) covers ${describeKeypers(keypers)} on chat ${chatId}`);
      if (operators.length > 0) console.log(`operators recorded: ${operators.join(",")}`);
      break;
    }

    // Clears the list. The group covers nothing until `add-keypers` runs, and every message it
    // sends fails until then, so the two are run together when a group is being changed.
    case "remove-keypers": {
      const [chatId] = args;
      if (chatId === undefined) usage();
      const userId = await userFor(chatId);
      if (attributesOf((await users.get(userId))!).kind !== "keyper") {
        console.error(`chat ${chatId} is not a keyper group; nothing was changed`);
        process.exit(1);
      }
      const removed = keypersOf((await users.get(userId))!);
      await amendAttributes(userId, (current) => ({ ...current, keypers: [] }));
      console.log(
        `chat ${chatId} no longer covers ${describeKeypers(removed)}; run add-keypers before it is messaged again`,
      );
      break;
    }

    // Adds to the list and leaves the rest alone. A pair already held by this group is kept once.
    case "add-keypers": {
      const [chatId, ...pairArgs] = args;
      if (chatId === undefined) usage();
      const userId = await userFor(chatId);
      const user = (await users.get(userId))!;
      if (attributesOf(user).kind !== "keyper") {
        console.error(`chat ${chatId} is not a keyper group; nothing was changed`);
        process.exit(1);
      }
      const adding = parsePairs(pairArgs);
      await assertAssignable(adding, userId);
      const next = await amendAttributes(userId, (current) => {
        const held = Array.isArray(current.keypers) ? current.keypers : [];
        const fresh = adding.filter(
          (one) => !held.some((kept) => kept.instance === one.instance && kept.set === one.set),
        );
        return { ...current, keypers: [...held, ...fresh] };
      });
      console.log(`chat ${chatId} now covers ${describeKeypers(next.keypers ?? [])}`);
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
