import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addressed, handlesFor } from "./mentions.ts";

const known = new Map([
  ["874974777", "ada"],
  ["111", "grace"],
]);

describe("handlesFor", () => {
  it("resolves the recorded operators, in the order they are recorded", () => {
    assert.deepEqual(handlesFor(["111", "874974777"], known), ["grace", "ada"]);
  });

  it("leaves out an operator with no handle rather than inventing one", () => {
    assert.deepEqual(handlesFor(["874974777", "222"], known), ["ada"]);
  });

  it("names each handle once, however many times it is recorded", () => {
    assert.deepEqual(handlesFor(["111", "111"], known), ["grace"]);
  });

  it("is empty when the room records no operator at all", () => {
    assert.deepEqual(handlesFor([], known), []);
  });
});

describe("addressed", () => {
  it("puts the handle on a line of its own, above the text untouched", () => {
    const text = "7-day uptime for kpr-one (api-gnosis-1003): 99.89%.";
    assert.equal(addressed(text, ["874974777"], known), `@ada\n${text}`);
  });

  it("addresses every operator on the one line", () => {
    assert.equal(addressed("up?", ["874974777", "111"], known), "@ada @grace\nup?");
  });

  // The whole point of the fallback: a room whose operator has never been seen writing is no worse
  // off than it was before mentions existed, and is told nothing about it.
  it("sends the text exactly as it was when no operator can be addressed", () => {
    assert.equal(addressed("up?", ["999"], known), "up?");
    assert.equal(addressed("up?", [], known), "up?");
  });

  it("does not touch a text that already reads like a mention", () => {
    assert.equal(addressed("@everyone: up?", ["999"], known), "@everyone: up?");
  });
});
