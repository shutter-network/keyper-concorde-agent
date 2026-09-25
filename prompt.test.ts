import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MessageRecord } from "@shutter-network/concorde/messenger";
import { promptData, roleOf, UnboundGroupError } from "./prompt.ts";
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

const bound = { name: "Ops kpr-jstcz", keyper: "kpr-jstcz", operators: [operator] };

describe("telling an operator from a teammate", () => {
  it("knows the operator", () => {
    assert.equal(roleOf(senderOf(operator, "alice"), [operator]), "the operator");
  });

  it("calls everyone else a teammate", () => {
    assert.equal(roleOf(senderOf(teammate, "bob"), [operator]), "a teammate");
  });

  // A group nobody has been labelled in yet still works; everyone in it is simply a teammate.
  it("calls everyone a teammate while no operator is recorded", () => {
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
  it("carries the keyper, the writer and their role", () => {
    // No username, no first name, no id: naming the room's members is not the model's business,
    // and the answer is attached to the question instead.
    assert.deepEqual(promptData(message, senderOf(operator, "alice", "Alice"), bound), {
      userId: message.userId,
      text: "how is it doing",
      keyper: "kpr-jstcz",
      role: "the operator",
    });
  });

  it("supplies the role as null rather than leaving it out", () => {
    const data = promptData(message, undefined, bound);
    assert.equal(data.role, null);
    // Handlebars runs strict here: a key the template names and this omits fails the Signal.
    assert.deepEqual(Object.keys(data).sort(), ["keyper", "role", "text", "userId"]);
  });

  // The whole point of dropping the writer: a handle must not reach the model through the values
  // this builds. One written into the message text still does, and cannot be helped here.
  it("carries no username, first name or sender id anywhere", () => {
    const data = promptData(message, senderOf(operator, "alice", "Alice"), bound);
    const rendered = JSON.stringify(data);
    for (const leak of ["alice", "Alice", operator]) {
      assert.equal(rendered.includes(leak), false, `${leak} reached the prompt values`);
    }
  });

  // A hand-edited row is the reason `promptData` checks rather than casts, and a sender id written
  // as a number is the likeliest way to write one.
  it("knows an operator whose id was written as a number", () => {
    const data = promptData(message, senderOf(operator, "alice"), {
      keyper: "kpr-jstcz",
      operators: [Number(operator)],
    });
    assert.equal(data.role, "the operator");
  });

  it("survives operators that are not a list at all", () => {
    for (const operators of ["874974777", 874974777, null, {}]) {
      const data = promptData(message, senderOf(operator, "alice"), { keyper: "kpr-jstcz", operators });
      assert.equal(data.role, "a teammate");
    }
  });

  it("treats missing operators as an empty list", () => {
    const data = promptData(message, senderOf(operator, "alice"), { keyper: "kpr-jstcz" });
    assert.equal(data.role, "a teammate");
  });

  // A group with no keyper is a hand-edited row, and answering about nothing is worse than failing:
  // the Handler's post phase tells the room the message could not be processed.
  it("refuses a group bound to no keyper", () => {
    for (const attributes of [null, undefined, {}, { keyper: "" }, { name: "Ops" }, "nonsense"]) {
      assert.throws(() => promptData(message, undefined, attributes), UnboundGroupError);
    }
  });
});
