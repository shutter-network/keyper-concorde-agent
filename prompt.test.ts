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

  // Telegram permissions already limit posting in a keyper chat to its operator.
  // Until `add-operator` records their ID, the agent labels that operator as a teammate.
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

  // A teammate chat has no assigned keyper or registered operators, so its senders are teammates.
  it("names no keyper for a teammate chat, and calls its writer a teammate", () => {
    assert.deepEqual(promptData(message, senderOf(teammate, "bob"), teammateChat), {
      userId: message.userId,
      text: "how is it doing",
      keyper: null,
      role: "a teammate",
    });
  });

  it("supplies every key the template names, even when null", () => {
    // Handlebars strict mode fails if any field used by the template is missing.
    const data = promptData(message, undefined, teammateChat);
    assert.equal(data.role, null);
    assert.deepEqual(Object.keys(data).sort(), ["keyper", "role", "text", "userId"]);
  });

  // Do not add usernames to the prompt data. Usernames typed into the message text
  // are still passed through; this function does not remove them from the text.
  it("carries no username, first name or sender id anywhere", () => {
    const rendered = JSON.stringify(
      promptData(message, senderOf(operator, "alice", "Alice"), keyperChat),
    );
    for (const leak of ["alice", "Alice", operator]) {
      assert.equal(rendered.includes(leak), false, `${leak} reached the prompt values`);
    }
  });

  // Manual database edits may store sender IDs as numbers. `promptData` must normalize
  // those values so it can still recognize the operator.
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

  // Reject a keyper chat with no valid keyper assignment because the agent cannot know which
  // keyper to answer about. The Handler sends the group a failure message in its post phase.
  it("refuses a keyper chat bound to no keyper", () => {
    for (const keyper of [undefined, "", null, 42]) {
      assert.throws(() => promptData(message, undefined, { kind: "keyper", keyper }), UnboundGroupError);
    }
  });

  // Reject an invalid chat kind instead of choosing a default. A teammate chat can contact
  // every operator, so an invalid value in a manually edited row must not grant that permission.
  it("refuses a chat whose kind it cannot read", () => {
    for (const attributes of [null, undefined, {}, "nonsense", { kind: "keyperr" }, { keyper: "kpr-jstcz" }]) {
      assert.throws(() => promptData(message, undefined, attributes), UnknownGroupKindError);
    }
  });

  // Ignore an extra keyper field on a teammate chat. `admin.ts` never adds it, but the chat is still valid.
  it("ignores a stray keyper on a teammate chat", () => {
    const data = promptData(message, senderOf(teammate, "bob"), {
      kind: "teammate",
      keyper: "kpr-jstcz",
    });
    assert.equal(data.keyper, null);
    assert.equal(data.role, "a teammate");
  });
});
