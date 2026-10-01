import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MessageRecord } from "@shutter-network/concorde/messenger";
import { promptData, roleOf, UnboundGroupError, UnknownGroupKindError } from "./prompt.ts";
import type { TelegramSender } from "./telegram-channel/index.ts";

const operator = "874974777";
const teammate = "891567187";

const senderOf = (
  senderId: string | null,
  username: string | null,
  firstName: string | null = null,
): TelegramSender => ({
  senderId,
  username,
  firstName,
  chatId: "-1001234567890",
  chatType: "supergroup",
  telegramMessageId: "45",
});

const message: MessageRecord = {
  id: "b1a1f0de-0000-4000-8000-000000000001",
  userId: "a9aeb409-f0c1-4600-9cbb-ebccb83da8b4",
  direction: "inbound",
  text: "how is it doing",
  createdAt: new Date().toISOString(),
};

const keyperChat = {
  kind: "keyper",
  name: "Ops kpr-jstcz",
  keyper: "kpr-jstcz",
  operators: [operator],
};
const teammateChat = { kind: "teammate", name: "Shutter team" };

describe("telling an operator from a teammate", () => {
  it("knows the operator", () => {
    assert.equal(roleOf(senderOf(operator, "alice"), [operator]), "the operator");
  });

  it("calls everyone else a teammate", () => {
    assert.equal(roleOf(senderOf(teammate, "bob"), [operator]), "a teammate");
  });

  // Telegram already stops a teammate writing in a keyper chat, so this is the operator nobody has
  // recorded yet, not a stranger. They read as a teammate until `add-operator` runs.
  it("calls a writer a teammate while no operator is recorded", () => {
    assert.equal(roleOf(senderOf(operator, "alice"), []), "a teammate");
  });

  it("knows any of several operators", () => {
    assert.equal(roleOf(senderOf(teammate, "bob"), [operator, teammate]), "the operator");
  });

  it("gives no role where there is no sender to give one to", () => {
    assert.equal(roleOf(senderOf(null, null), [operator]), null);
    assert.equal(roleOf(undefined, [operator]), null);
  });
});

describe("assembling the prompt's values", () => {
  it("names the keyper a keyper chat covers, and the writer's role", () => {
    assert.deepEqual(
      promptData(message, senderOf(operator, "alice", "Alice"), keyperChat),
      {
        userId: message.userId,
        text: "how is it doing",
        keyper: "kpr-jstcz",
        role: "the operator",
      },
    );
  });

  // No keyper, and nobody in it is an operator, so everyone who writes there is a teammate.
  it("names no keyper for a teammate chat, and calls its writer a teammate", () => {
    assert.deepEqual(promptData(message, senderOf(teammate, "bob"), teammateChat), {
      userId: message.userId,
      text: "how is it doing",
      keyper: null,
      role: "a teammate",
    });
  });

  it("supplies every key the template names, even when null", () => {
    // Handlebars runs strict here: a key the template names and this omits fails the Signal.
    const data = promptData(message, undefined, teammateChat);
    assert.equal(data.role, null);
    assert.deepEqual(Object.keys(data).sort(), ["keyper", "role", "text", "userId"]);
  });

  // A handle must not reach the model through the values this builds. One written into the message
  // text still does, and cannot be helped here.
  it("carries no username, first name or sender id anywhere", () => {
    const rendered = JSON.stringify(
      promptData(message, senderOf(operator, "alice", "Alice"), keyperChat),
    );
    for (const leak of ["alice", "Alice", operator]) {
      assert.equal(rendered.includes(leak), false, `${leak} reached the prompt values`);
    }
  });

  // `promptData` checks rather than casts because a row may have been edited by hand. A sender id
  // as a number is the likeliest way to write one.
  it("knows an operator whose id was written as a number", () => {
    const data = promptData(message, senderOf(operator, "alice"), {
      ...keyperChat,
      operators: [Number(operator)],
    });
    assert.equal(data.role, "the operator");
  });

  it("survives operators that are not a list at all", () => {
    for (const operators of ["874974777", 874974777, null, {}]) {
      const data = promptData(message, senderOf(operator, "alice"), { ...keyperChat, operators });
      assert.equal(data.role, "a teammate");
    }
  });

  // A keyper chat with no keyper would answer about nothing, which is worse than failing: the
  // Handler's post phase tells the chat its message could not be processed.
  it("refuses a keyper chat bound to no keyper", () => {
    for (const keyper of [undefined, "", null, 42]) {
      assert.throws(() => promptData(message, undefined, { kind: "keyper", keyper }), UnboundGroupError);
    }
  });

  // An unreadable kind must not fall back to either kind. A teammate chat may message every
  // operator, and a hand-edited row must not be able to grant that.
  it("refuses a chat whose kind it cannot read", () => {
    for (const attributes of [null, undefined, {}, "nonsense", { kind: "keyperr" }, { keyper: "kpr-jstcz" }]) {
      assert.throws(() => promptData(message, undefined, attributes), UnknownGroupKindError);
    }
  });

  // Not refused for carrying one: admin.ts will not create one, and the chat otherwise works.
  it("ignores a stray keyper on a teammate chat", () => {
    const data = promptData(message, senderOf(teammate, "bob"), {
      kind: "teammate",
      keyper: "kpr-jstcz",
    });
    assert.equal(data.keyper, null);
    assert.equal(data.role, "a teammate");
  });
});
