import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import Fastify from "fastify";
import type { Db } from "@shutter-network/concorde/db";
import { serverComponent } from "@shutter-network/concorde/gateway";
import { createMessenger, type Channel, type MessageRecord } from "@shutter-network/concorde/messenger";
import * as messengerSchema from "@shutter-network/concorde/messenger/schema";
import { createSignalWorker, type Runtime } from "@shutter-network/concorde/signals";
import * as signalsSchema from "@shutter-network/concorde/signals/schema";
import { signals } from "@shutter-network/concorde/signals/schema";
import { createUsers } from "@shutter-network/concorde/users";
import * as usersSchema from "@shutter-network/concorde/users/schema";
import {
  applySchema,
  createTestDatabase,
  silent,
  type TestDatabase,
} from "../telegram-channel/test-support.ts";
import { createAnnouncements } from "./announce.ts";
import { createRounds, maxAttempts, roundCompletedKind, type Rounds } from "./rounds.ts";
import * as roundsSchema from "./schema/index.ts";

const nowhere = { port: 0, host: "127.0.0.1" } as const;

let database: TestDatabase;
let db: Db;
let users: ReturnType<typeof createUsers>;
let rounds: Rounds;
let api: ReturnType<typeof Fastify>;
let sent: { userId: string; text: string }[];
// Stands in for the Channel: a User is reachable once a chat is recorded for it. `remove-chat`
// leaves the User behind, so having a keyper and being reachable are different things.
let withChat: Set<string>;
// Also stands in for the Channel: the handle last seen for a sender. A sender that has never been
// seen writing is simply absent, which is the case a room with an unaddressable operator exercises.
let handles: Map<string, string>;

// Enough of a Channel for the Messenger to accept a send. The rounds component only cares that a
// question left the building, not how.
const recordingChannel = (): Channel => ({
  name: "recording",
  async send(_tx, message: MessageRecord) {
    sent.push({ userId: message.userId, text: message.text });
  },
  async start() {},
  async stop() {},
});

async function keyperChat(
  name: string,
  keyper: string,
  operators: readonly string[] = [],
): Promise<string> {
  const id = await db.tx(async (tx) => {
    const user = await users.create(tx);
    await users.setAttributes(tx, user.id, { kind: "keyper", name, keyper, operators });
    return user.id;
  });
  withChat.add(id);
  return id;
}

/** A keyper User whose chat was removed: still there, still bound, unreachable. */
async function keyperUserWithoutChat(name: string, keyper: string): Promise<string> {
  return db.tx(async (tx) => {
    const user = await users.create(tx);
    await users.setAttributes(tx, user.id, { kind: "keyper", name, keyper });
    return user.id;
  });
}

async function teammateChat(name: string): Promise<string> {
  const id = await db.tx(async (tx) => {
    const user = await users.create(tx);
    await users.setAttributes(tx, user.id, { kind: "teammate", name });
    return user.id;
  });
  withChat.add(id);
  return id;
}

const post = (url: string, payload: unknown) => api.inject({ method: "POST", url, payload });
const get = (url: string) => api.inject({ method: "GET", url });

const completedSignals = async () =>
  (await db.handle({ signals }).select().from(signals).where(eq(signals.kind, roundCompletedKind)))
    .length;

const utc = (hour: number) => `2026-10-01T${String(hour).padStart(2, "0")}:00:00Z`;

before(async () => {
  database = await createTestDatabase("keyper_rounds");
  db = database.db;
  await applySchema(db, signalsSchema, usersSchema, messengerSchema, roundsSchema);
  users = createUsers({ db });
  withChat = new Set<string>();
  handles = new Map<string, string>();
  api = Fastify();
  const agentServer = serverComponent(api, nowhere);
  const runtime: Runtime = { run: async () => ({ ok: true }) };
  const worker = createSignalWorker({ db, runtime, handlers: {}, logger: silent });
  const messenger = createMessenger({ db, users, worker, agentServer });
  messenger.register(recordingChannel());
  const reachable = async (userId: string) => withChat.has(userId);
  const usernamesOf = async (senderIds: readonly string[]) =>
    new Map(
      senderIds.flatMap((id) => {
        const handle = handles.get(id);
        return handle === undefined ? [] : [[id, handle] as [string, string]];
      }),
    );
  rounds = createRounds({ db, users, messenger, worker, agentServer, reachable, usernamesOf });
  createAnnouncements({ db, users, messenger, agentServer, reachable, usernamesOf });
  await api.ready();
});

after(() => database.drop());

beforeEach(() => {
  sent = [];
  handles = new Map<string, string>();
});

describe("opening a round", () => {
  it("asks every keyper that has a chat, and names the ones that do not", async () => {
    const asking = await teammateChat("team");
    const one = await keyperChat("ops one", "kpr-one");
    const two = await keyperChat("ops two", "kpr-two");
    rounds.actingFor({ userId: asking, telegramMessageId: "500" });

    const reply = await post("/rounds", {
      keyperset: "set-a",
      keypers: ["kpr-one", "kpr-two", "kpr-absent"],
      question: "When can you do a DKG?",
    });
    const body = reply.json();

    assert.equal(reply.statusCode, 200);
    assert.equal(body.opened, true);
    assert.deepEqual(body.asked.sort(), ["kpr-one", "kpr-two"]);
    // Named rather than dropped: a short fan-out otherwise looks exactly like a complete one.
    assert.deepEqual(body.noChat, ["kpr-absent"]);
    assert.deepEqual(
      sent.map((m) => m.userId).sort(),
      [one, two].sort(),
    );
    assert.equal(sent[0].text, "When can you do a DKG?");
  });

  it("refuses when not one of the keypers has a chat", async () => {
    rounds.actingFor({ userId: await teammateChat("team b"), telegramMessageId: "501" });
    const reply = await post("/rounds", {
      keyperset: "set-nobody",
      keypers: ["kpr-nowhere"],
      question: "anyone?",
    });
    assert.equal(reply.statusCode, 409);
    assert.equal(sent.length, 0);
  });

  it("refuses when no Run is in flight, rather than guessing who asked", async () => {
    rounds.actingFor(undefined);
    const reply = await post("/rounds", { keyperset: "set-c", keypers: ["kpr-one"], question: "?" });
    assert.equal(reply.statusCode, 409);
  });

  // Two open rounds would make an operator's reply ambiguous: nothing would say which it answered.
  it("returns the open round for that keyperset instead of opening a second", async () => {
    const asking = await teammateChat("team d");
    await keyperChat("ops d", "kpr-d");
    rounds.actingFor({ userId: asking, telegramMessageId: "502" });
    const first = (await post("/rounds", { keyperset: "set-d", keypers: ["kpr-d"], question: "first" })).json();

    sent = [];
    const second = (await post("/rounds", { keyperset: "set-d", keypers: ["kpr-d"], question: "again" })).json();

    assert.equal(second.opened, false);
    assert.equal(second.round.id, first.round.id);
    assert.equal(second.round.question, "first"); // the original question, not the repeat
    assert.deepEqual(second.waitingOn, ["kpr-d"]);
    assert.equal(sent.length, 0, "nobody is asked twice");
  });
});

describe("recording an answer", () => {
  it("refuses a chat the round never asked", async () => {
    const asking = await teammateChat("team e");
    await keyperChat("ops e", "kpr-e");
    const stranger = await keyperChat("ops f", "kpr-f");
    rounds.actingFor({ userId: asking, telegramMessageId: "503" });
    const round = (await post("/rounds", { keyperset: "set-e", keypers: ["kpr-e"], question: "?" })).json();

    rounds.actingFor({ userId: stranger, telegramMessageId: "504" });
    const reply = await post(`/rounds/${round.round.id}/answers`, {
      from: utc(9),
      to: utc(17),
      said: "all day",
    });
    assert.equal(reply.statusCode, 404);
  });

  // A window that means nothing would still count towards the round being complete.
  it("refuses a window it cannot read, or one that ends before it starts", async () => {
    const asking = await teammateChat("team g");
    const one = await keyperChat("ops g", "kpr-g");
    rounds.actingFor({ userId: asking, telegramMessageId: "505" });
    const round = (await post("/rounds", { keyperset: "set-g", keypers: ["kpr-g"], question: "?" })).json();

    rounds.actingFor({ userId: one, telegramMessageId: "506" });
    for (const body of [
      { from: "tuesday", to: utc(17), said: "tuesday" },
      { from: utc(17), to: utc(9), said: "backwards" },
      { from: utc(9), to: utc(9), said: "no width" },
    ]) {
      assert.equal((await post(`/rounds/${round.round.id}/answers`, body)).statusCode, 400);
    }
    assert.equal(await completedSignals(), 0);
  });

  it("replaces an earlier answer rather than adding one", async () => {
    const asking = await teammateChat("team h");
    const one = await keyperChat("ops h1", "kpr-h1");
    await keyperChat("ops h2", "kpr-h2");
    rounds.actingFor({ userId: asking, telegramMessageId: "507" });
    const round = (
      await post("/rounds", { keyperset: "set-h", keypers: ["kpr-h1", "kpr-h2"], question: "?" })
    ).json();

    rounds.actingFor({ userId: one, telegramMessageId: "508" });
    await post(`/rounds/${round.round.id}/answers`, { from: utc(9), to: utc(12), said: "morning" });
    const second = await post(`/rounds/${round.round.id}/answers`, {
      from: utc(14),
      to: utc(16),
      said: "actually, afternoon",
    });

    // Still one of two answered: a correction is one answer, not two.
    assert.equal(second.json().complete, false);
    assert.deepEqual(second.json().waitingOn, ["kpr-h2"]);
  });
});

describe("completing a round", () => {
  it("emits one signal when the last operator answers, and not before", async () => {
    const before = await completedSignals();
    const asking = await teammateChat("team i");
    const one = await keyperChat("ops i1", "kpr-i1");
    const two = await keyperChat("ops i2", "kpr-i2");
    rounds.actingFor({ userId: asking, telegramMessageId: "509" });
    const round = (
      await post("/rounds", { keyperset: "set-i", keypers: ["kpr-i1", "kpr-i2"], question: "?" })
    ).json();

    rounds.actingFor({ userId: one, telegramMessageId: "510" });
    const first = await post(`/rounds/${round.round.id}/answers`, { from: utc(9), to: utc(17), said: "9-5" });
    assert.equal(first.json().complete, false);
    assert.equal(await completedSignals(), before, "not before every operator has answered");

    rounds.actingFor({ userId: two, telegramMessageId: "511" });
    const last = await post(`/rounds/${round.round.id}/answers`, { from: utc(13), to: utc(19), said: "1-7" });
    assert.equal(last.json().complete, true);
    assert.deepEqual(last.json().waitingOn, []);
    assert.equal(await completedSignals(), before + 1);
  });

  // `reportedAt` is stamped in the transaction that completes the round, so a later correction
  // records fine but cannot report the round a second time.
  it("does not emit again when an operator corrects themselves afterwards", async () => {
    const asking = await teammateChat("team j");
    const one = await keyperChat("ops j", "kpr-j");
    rounds.actingFor({ userId: asking, telegramMessageId: "512" });
    const round = (await post("/rounds", { keyperset: "set-j", keypers: ["kpr-j"], question: "?" })).json();

    rounds.actingFor({ userId: one, telegramMessageId: "513" });
    await post(`/rounds/${round.round.id}/answers`, { from: utc(9), to: utc(17), said: "9-5" });
    const before = await completedSignals();

    const again = await post(`/rounds/${round.round.id}/answers`, {
      from: utc(10),
      to: utc(16),
      said: "actually 10-4",
    });
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().complete, false, "already reported, so this completes nothing");
    assert.equal(await completedSignals(), before);
  });
});

describe("where a round stands, and closing it", () => {
  it("names who is still being waited on", async () => {
    const asking = await teammateChat("team k");
    const one = await keyperChat("ops k1", "kpr-k1");
    await keyperChat("ops k2", "kpr-k2");
    rounds.actingFor({ userId: asking, telegramMessageId: "514" });
    const round = (
      await post("/rounds", { keyperset: "set-k", keypers: ["kpr-k1", "kpr-k2"], question: "?" })
    ).json();

    rounds.actingFor({ userId: one, telegramMessageId: "515" });
    await post(`/rounds/${round.round.id}/answers`, { from: utc(9), to: utc(17), said: "9-5" });

    const state = (await get("/rounds?keyperset=set-k")).json().rounds[0];
    assert.deepEqual(state.answered, ["kpr-k1"]);
    assert.deepEqual(state.waitingOn, ["kpr-k2"]);
  });

  // A round that reported is finished. Leaving it "open" would block its keyperset on a round that
  // has nothing left to do, which is what closing by hand was being used to work around.
  it("stops blocking its keyperset the moment it reports, with nobody closing it", async () => {
    const asking = await teammateChat("team s");
    const one = await keyperChat("ops s", "kpr-s");
    rounds.actingFor({ userId: asking, telegramMessageId: "520" });
    const first = (await post("/rounds", { keyperset: "set-s", keypers: ["kpr-s"], question: "first" })).json();

    rounds.actingFor({ userId: one, telegramMessageId: "521" });
    const answered = await post(`/rounds/${first.round.id}/answers`, {
      from: utc(9),
      to: utc(17),
      said: "9-5",
    });
    assert.equal(answered.json().complete, true);

    // No close call in between.
    rounds.actingFor({ userId: asking, telegramMessageId: "522" });
    const second = (await post("/rounds", { keyperset: "set-s", keypers: ["kpr-s"], question: "second" })).json();
    assert.equal(second.opened, true);
    assert.notEqual(second.round.id, first.round.id);

    // And it is no longer something anybody is waiting on.
    assert.deepEqual(
      (await get("/rounds?keyperset=set-s")).json().rounds.map((r: { id: string }) => r.id),
      [second.round.id],
    );
  });

  it("has nothing left to close once it has reported", async () => {
    const asking = await teammateChat("team t");
    const one = await keyperChat("ops t", "kpr-t");
    rounds.actingFor({ userId: asking, telegramMessageId: "523" });
    const round = (await post("/rounds", { keyperset: "set-t", keypers: ["kpr-t"], question: "?" })).json();
    rounds.actingFor({ userId: one, telegramMessageId: "524" });
    await post(`/rounds/${round.round.id}/answers`, { from: utc(9), to: utc(17), said: "9-5" });

    const closing = await post(`/rounds/${round.round.id}/close`, {});
    assert.equal(closing.statusCode, 404);
    assert.match(closing.json().error, /already finished/);
  });

  // Nothing expires on its own, so this is the only way a permanently silent operator stops
  // blocking their keyperset.
  it("lets the keyperset be asked again once closed", async () => {
    const asking = await teammateChat("team l");
    await keyperChat("ops l", "kpr-l");
    rounds.actingFor({ userId: asking, telegramMessageId: "516" });
    const first = (await post("/rounds", { keyperset: "set-l", keypers: ["kpr-l"], question: "first" })).json();

    assert.equal((await post(`/rounds/${first.round.id}/close`, {})).json().closed, true);
    // Closing twice is not a way to close somebody else's round by accident.
    assert.equal((await post(`/rounds/${first.round.id}/close`, {})).statusCode, 404);

    const second = (await post("/rounds", { keyperset: "set-l", keypers: ["kpr-l"], question: "second" })).json();
    assert.equal(second.opened, true);
    assert.notEqual(second.round.id, first.round.id);
  });
});

describe("telling each keyper's operators something", () => {
  it("writes each keyper's own text to its own chat, and names the ones with no chat", async () => {
    const one = await keyperChat("ops m1", "kpr-m1");
    const two = await keyperChat("ops m2", "kpr-m2");

    const reply = await post("/announce", {
      messages: [
        { keyper: "kpr-m1", text: "kpr-m1 was up 99.9% this week" },
        { keyper: "kpr-m2", text: "kpr-m2 was up 92.4% this week" },
        { keyper: "kpr-m-absent", text: "nobody reads this" },
      ],
    });
    const body = reply.json();

    assert.equal(reply.statusCode, 200);
    assert.deepEqual(body.told, ["kpr-m1", "kpr-m2"]);
    assert.deepEqual(body.noChat, ["kpr-m-absent"]);
    // Each operator's own number, not the fleet's.
    assert.deepEqual(
      sent.sort((a, b) => a.userId.localeCompare(b.userId)),
      [
        { userId: one, text: "kpr-m1 was up 99.9% this week" },
        { userId: two, text: "kpr-m2 was up 92.4% this week" },
      ].sort((a, b) => a.userId.localeCompare(b.userId)),
    );
  });

  it("needs no Run in flight, because it answers nobody", async () => {
    await keyperChat("ops n", "kpr-n");
    rounds.actingFor(undefined);
    const reply = await post("/announce", { messages: [{ keyper: "kpr-n", text: "a notice" }] });
    assert.equal(reply.statusCode, 200);
    assert.equal(sent.length, 1);
  });

  it("refuses when not one of them has a chat, rather than reporting success", async () => {
    const reply = await post("/announce", { messages: [{ keyper: "kpr-nowhere", text: "hello" }] });
    assert.equal(reply.statusCode, 409);
    assert.deepEqual(reply.json().noChat, ["kpr-nowhere"]);
    assert.equal(sent.length, 0);
  });

  it("refuses a message missing its keyper or its text", async () => {
    await keyperChat("ops o", "kpr-o");
    for (const messages of [[{ keyper: "kpr-o" }], [{ text: "orphan" }], []]) {
      assert.equal((await post("/announce", { messages })).statusCode, 400);
    }
    assert.equal(sent.length, 0);
  });
});

describe("addressing a room's operator", () => {
  // Neither a fan-out nor a round's question is a reply, so neither quotes anything. Without the
  // handle a room is shown a bare statement with nothing saying its operator is the one being asked.
  it("puts the operator's handle above a fan-out, and leaves the text alone", async () => {
    handles.set("874974777", "ada");
    const chat = await keyperChat("ops q1", "kpr-men-1", ["874974777"]);

    const reply = await post("/announce", {
      messages: [{ keyper: "kpr-men-1", text: "7-day uptime for kpr-men-1: 99.89%." }],
    });

    assert.equal(reply.statusCode, 200);
    assert.deepEqual(sent, [
      { userId: chat, text: "@ada\n7-day uptime for kpr-men-1: 99.89%." },
    ]);
  });

  it("addresses each room's own operator and nobody else's", async () => {
    handles.set("1", "ada");
    handles.set("2", "grace");
    const one = await keyperChat("ops q2", "kpr-men-2", ["1"]);
    const two = await keyperChat("ops q3", "kpr-men-3", ["2"]);

    await post("/announce", {
      messages: [
        { keyper: "kpr-men-2", text: "yours is up" },
        { keyper: "kpr-men-3", text: "yours is down" },
      ],
    });

    assert.deepEqual(
      sent.sort((a, b) => a.userId.localeCompare(b.userId)),
      [
        { userId: one, text: "@ada\nyours is up" },
        { userId: two, text: "@grace\nyours is down" },
      ].sort((a, b) => a.userId.localeCompare(b.userId)),
    );
  });

  // The fallback is the common case at first: under group privacy the bot only sees an @mention or
  // a reply to itself, so an operator recorded from the enrollment reply and silent since has no
  // handle on file at all.
  it("sends exactly what it would have when the operator has never been seen writing", async () => {
    const chat = await keyperChat("ops q4", "kpr-men-4", ["874974777"]);
    await post("/announce", { messages: [{ keyper: "kpr-men-4", text: "kpr-men-4 is up" }] });
    assert.deepEqual(sent, [{ userId: chat, text: "kpr-men-4 is up" }]);
  });

  it("addresses the operator a round's question is asked of", async () => {
    handles.set("3", "ada");
    const asking = await teammateChat("team mention a");
    const chat = await keyperChat("ops q5", "kpr-men-6", ["3"]);
    rounds.actingFor({ userId: asking, telegramMessageId: "900" });

    await post("/rounds", {
      keyperset: "set-mention-a",
      keypers: ["kpr-men-6"],
      question: "When can you do a DKG?",
    });

    assert.deepEqual(sent, [{ userId: chat, text: "@ada\nWhen can you do a DKG?" }]);
  });

  it("addresses an operator asked to move, on every attempt", async () => {
    handles.set("4", "ada");
    handles.set("5", "grace");
    const asking = await teammateChat("team mention c");
    const early = await keyperChat("ops r1", "kpr-men-7", ["4"]);
    const late = await keyperChat("ops r2", "kpr-men-8", ["5"]);
    rounds.actingFor({ userId: asking, telegramMessageId: "901" });
    const opened = (
      await post("/rounds", { keyperset: "set-mention-c", keypers: ["kpr-men-7", "kpr-men-8"], question: "when?" })
    ).json();

    sent = [];
    const reply = await post(`/rounds/${opened.round.id}/revise`, {
      keypers: ["kpr-men-8"],
      text: "Could you move to 13:00-15:00 UTC?",
    });

    assert.equal(reply.statusCode, 200);
    // Only the outlier is written to, and it is their own handle that is used, not the round's.
    assert.deepEqual(sent, [
      { userId: late, text: "@grace\nCould you move to 13:00-15:00 UTC?" },
    ]);
    assert.notEqual(late, early);
  });

  // A handle recorded after the round opened still reaches them: the lookup is fresh per message,
  // not remembered from when the round was created.
  it("uses a handle first seen after the round opened", async () => {
    const asking = await teammateChat("team mention b");
    const chat = await keyperChat("ops s1", "kpr-men-5", ["6"]);
    rounds.actingFor({ userId: asking, telegramMessageId: "902" });
    const opened = (
      await post("/rounds", { keyperset: "set-mention-b", keypers: ["kpr-men-5"], question: "when?" })
    ).json();
    assert.deepEqual(sent, [{ userId: chat, text: "when?" }]);

    sent = [];
    handles.set("6", "ada");
    await post(`/rounds/${opened.round.id}/revise`, {
      keypers: ["kpr-men-5"],
      text: "Could you move?",
    });

    assert.deepEqual(sent, [{ userId: chat, text: "@ada\nCould you move?" }]);
  });
});

describe("a keyper whose chat was removed", () => {
  // Found live: two Users shared one keyper, one of them left chatless by `remove-chat`, and which
  // one was taken came down to the order `users.list` returned. The chatless one won, and that
  // keyper's operators were told nothing while everything looked fine.
  it("is not mistaken for that keyper's chat when another User has one", async () => {
    await keyperUserWithoutChat("orphan p", "kpr-p");
    const live = await keyperChat("ops p", "kpr-p");

    const reply = await post("/announce", { messages: [{ keyper: "kpr-p", text: "your uptime" }] });

    assert.deepEqual(reply.json().noChat, []);
    assert.deepEqual(sent, [{ userId: live, text: "your uptime" }]);
  });

  it("leaves the keyper unreachable when it is the only User bound to it", async () => {
    await keyperUserWithoutChat("orphan q", "kpr-q");
    const reply = await post("/announce", { messages: [{ keyper: "kpr-q", text: "nobody" }] });
    assert.equal(reply.statusCode, 409);
    assert.deepEqual(reply.json().noChat, ["kpr-q"]);
    assert.equal(sent.length, 0);
  });

  // Keying by keyper alone wrote to one of them and said nothing about the other.
  it("writes to every chat that covers the keyper, not just one", async () => {
    const first = await keyperChat("ops r1", "kpr-r");
    const second = await keyperChat("ops r2", "kpr-r");

    await post("/announce", { messages: [{ keyper: "kpr-r", text: "both of you" }] });

    assert.deepEqual(
      sent.map((m) => m.userId).sort(),
      [first, second].sort(),
    );
  });
});

describe("converging when the windows do not meet", () => {
  // A round whose answers do not overlap is not finished: the operators are asked to move, and the
  // round is worked out again when they have.
  async function roundOf(tag: string, windows: readonly (readonly [number, number])[]) {
    const asking = await teammateChat(`team ${tag}`);
    const chats = await Promise.all(windows.map((_, i) => keyperChat(`ops ${tag}${i}`, `kpr-${tag}${i}`)));
    rounds.actingFor({ userId: asking, telegramMessageId: "600" });
    const round = (
      await post("/rounds", {
        keyperset: `set-${tag}`,
        keypers: chats.map((_, i) => `kpr-${tag}${i}`),
        question: "when can you do a DKG?",
      })
    ).json();
    for (const [i, [from, to]] of windows.entries()) {
      rounds.actingFor({ userId: chats[i], telegramMessageId: `60${i}` });
      await post(`/rounds/${round.round.id}/answers`, { from: utc(from), to: utc(to), said: "said" });
    }
    return { asking, chats, id: round.round.id };
  }

  it("does not report a round whose windows do not meet, while attempts remain", async () => {
    const before = await completedSignals();
    const { id } = await roundOf("u", [[9, 12], [14, 17]]);

    // Woken to negotiate, not to report: nothing is stamped, so the round is still live.
    assert.equal(await completedSignals(), before + 1);
    const [row] = await db.handle({ rounds: roundsSchema.rounds }).select().from(roundsSchema.rounds).where(eq(roundsSchema.rounds.id, id));
    assert.equal(row.reportedAt, null);
  });

  it("asks the named operators to move and counts the attempt", async () => {
    const { id, chats } = await roundOf("v", [[9, 12], [14, 17]]);
    sent = [];

    const reply = await post(`/rounds/${id}/revise`, {
      keypers: ["kpr-v1"],
      text: "the others can do 09:00-12:00, can you move?",
    });

    assert.deepEqual(reply.json().asked, ["kpr-v1"]);
    assert.equal(reply.json().attempts, 1);
    assert.equal(reply.json().attemptsLeft, maxAttempts - 1);
    assert.deepEqual(sent, [{ userId: chats[1], text: "the others can do 09:00-12:00, can you move?" }]);
  });

  it("works the round out again when the revision lands, and reports once they meet", async () => {
    const { id, chats } = await roundOf("w", [[9, 12], [14, 17]]);
    await post(`/rounds/${id}/revise`, { keypers: ["kpr-w1"], text: "please move" });
    const before = await completedSignals();

    rounds.actingFor({ userId: chats[1], telegramMessageId: "610" });
    const revised = await post(`/rounds/${id}/answers`, { from: utc(10), to: utc(13), said: "moved" });

    assert.equal(revised.json().complete, true);
    assert.equal(await completedSignals(), before + 1);
    const [row] = await db.handle({ rounds: roundsSchema.rounds }).select().from(roundsSchema.rounds).where(eq(roundsSchema.rounds.id, id));
    assert.notEqual(row.reportedAt, null, "they meet now, so the round is finished");
  });

  // An operator who cannot make it would otherwise be asked forever.
  it("refuses a further attempt once the bound is spent, and then reports", async () => {
    const { id, chats } = await roundOf("x", [[9, 12], [14, 17]]);
    for (let i = 0; i < maxAttempts; i++) {
      assert.equal((await post(`/rounds/${id}/revise`, { keypers: ["kpr-x1"], text: "move" })).statusCode, 200);
    }
    const refused = await post(`/rounds/${id}/revise`, { keypers: ["kpr-x1"], text: "move again" });
    assert.equal(refused.statusCode, 409);

    // The next answer ends the round even though the windows still do not meet.
    rounds.actingFor({ userId: chats[1], telegramMessageId: "611" });
    await post(`/rounds/${id}/answers`, { from: utc(15), to: utc(18), said: "still later" });
    const [row] = await db.handle({ rounds: roundsSchema.rounds }).select().from(roundsSchema.rounds).where(eq(roundsSchema.rounds.id, id));
    assert.notEqual(row.reportedAt, null, "out of attempts, so it reports what it has");
  });

  it("refuses to revise a keyper the round never asked", async () => {
    const { id } = await roundOf("y", [[9, 12], [14, 17]]);
    assert.equal((await post(`/rounds/${id}/revise`, { keypers: ["kpr-elsewhere"], text: "?" })).statusCode, 404);
  });
});

describe("two outliers asked to move at once", () => {
  // Found live: one outlier replying re-completed the round while the other was still being waited
  // on, so the agent re-evaluated a half-updated picture, re-asked somebody it had already asked,
  // and spent a second attempt doing it.
  it("waits for every operator it asked, not just the first to reply", async () => {
    const asking = await teammateChat("team z");
    const early = await keyperChat("ops z0", "kpr-z0");
    const mid = await keyperChat("ops z1", "kpr-z1");
    const late = await keyperChat("ops z2", "kpr-z2");
    rounds.actingFor({ userId: asking, telegramMessageId: "700" });
    const round = (
      await post("/rounds", {
        keyperset: "set-z",
        keypers: ["kpr-z0", "kpr-z1", "kpr-z2"],
        question: "when?",
      })
    ).json();

    // z1 and z2 agree; z0 is on its own.
    for (const [chat, from, to] of [
      [early, 6, 8],
      [mid, 12, 16],
      [late, 13, 17],
    ] as const) {
      rounds.actingFor({ userId: chat, telegramMessageId: "701" });
      await post(`/rounds/${round.round.id}/answers`, { from: utc(from), to: utc(to), said: "said" });
    }

    // Both outliers -- here just z0 plus z2 for the sake of two -- are asked in one attempt.
    await post(`/rounds/${round.round.id}/revise`, { keypers: ["kpr-z0", "kpr-z2"], text: "move" });
    const before = await completedSignals();

    // The first of them replies. The round must stay shut: the other has not.
    rounds.actingFor({ userId: early, telegramMessageId: "702" });
    const first = await post(`/rounds/${round.round.id}/answers`, {
      from: utc(13),
      to: utc(16),
      said: "moved",
    });
    assert.equal(first.json().complete, false, "still waiting on the other one it asked");
    assert.equal(await completedSignals(), before, "and nothing woke the agent to re-ask them");

    // The second replies, and only now is the round worked out again.
    rounds.actingFor({ userId: late, telegramMessageId: "703" });
    const second = await post(`/rounds/${round.round.id}/answers`, {
      from: utc(13),
      to: utc(17),
      said: "moved too",
    });
    assert.equal(second.json().complete, true);
    assert.equal(await completedSignals(), before + 1);
  });

  it("tells a chat asked to move that it owes an answer again", async () => {
    const asking = await teammateChat("team aa");
    const one = await keyperChat("ops aa0", "kpr-aa0");
    const two = await keyperChat("ops aa1", "kpr-aa1");
    rounds.actingFor({ userId: asking, telegramMessageId: "710" });
    const round = (
      await post("/rounds", { keyperset: "set-aa", keypers: ["kpr-aa0", "kpr-aa1"], question: "?" })
    ).json();
    // Windows that do not meet, so the round stays open rather than reporting at once.
    for (const [chat, from, to] of [
      [one, 9, 12],
      [two, 14, 17],
    ] as const) {
      rounds.actingFor({ userId: chat, telegramMessageId: "711" });
      await post(`/rounds/${round.round.id}/answers`, { from: utc(from), to: utc(to), said: "said" });
    }

    // Answered, so nothing is owed.
    assert.equal(await rounds.awaiting(one), undefined);

    await post(`/rounds/${round.round.id}/revise`, { keypers: ["kpr-aa0"], text: "move" });

    // Asked to move: its prompt must say the round is open, or it cannot record the revision.
    assert.equal((await rounds.awaiting(one))?.id, round.round.id);
    // And the one not asked still owes nothing.
    assert.equal(await rounds.awaiting(two), undefined);
  });

  it("will not ask for a revision once the round has reported", async () => {
    const asking = await teammateChat("team ab");
    const one = await keyperChat("ops ab", "kpr-ab");
    rounds.actingFor({ userId: asking, telegramMessageId: "720" });
    const round = (await post("/rounds", { keyperset: "set-ab", keypers: ["kpr-ab"], question: "?" })).json();
    rounds.actingFor({ userId: one, telegramMessageId: "721" });
    await post(`/rounds/${round.round.id}/answers`, { from: utc(9), to: utc(12), said: "said" });

    const refused = await post(`/rounds/${round.round.id}/revise`, { keypers: ["kpr-ab"], text: "move" });
    assert.equal(refused.statusCode, 404);
  });
});
