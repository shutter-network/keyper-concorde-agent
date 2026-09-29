import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { largestAgreement, MalformedWindowError, overlapOf, parseWindow } from "./windows.ts";

const w = (from: string, to: string) => parseWindow(`2026-10-01T${from}:00Z`, `2026-10-01T${to}:00Z`);
const shown = (window: { from: Date; to: Date } | undefined) =>
  window === undefined ? "none" : `${window.from.toISOString()}/${window.to.toISOString()}`;

describe("reading a window", () => {
  it("takes a UTC interval", () => {
    const window = parseWindow("2026-10-01T13:00:00Z", "2026-10-01T17:00:00Z");
    assert.equal(window.from.toISOString(), "2026-10-01T13:00:00.000Z");
    assert.equal(window.to.toISOString(), "2026-10-01T17:00:00.000Z");
  });

  it("refuses an end that is not after the start", () => {
    assert.throws(() => parseWindow("2026-10-01T17:00:00Z", "2026-10-01T13:00:00Z"), MalformedWindowError);
    assert.throws(() => parseWindow("2026-10-01T13:00:00Z", "2026-10-01T13:00:00Z"), MalformedWindowError);
  });

  it("refuses what it cannot read as a time", () => {
    assert.throws(() => parseWindow("tuesday afternoon", "2026-10-01T17:00:00Z"), MalformedWindowError);
    assert.throws(() => parseWindow("2026-10-01T13:00:00Z", "later"), MalformedWindowError);
  });
});

describe("what the windows have in common", () => {
  it("finds the overlap of several", () => {
    assert.equal(shown(overlapOf([w("09", "17"), w("13", "19"), w("11", "15")])), shown(w("13", "15")));
  });

  it("finds none when one operator is free only later", () => {
    assert.equal(overlapOf([w("09", "12"), w("13", "17")]), undefined);
  });

  // A DKG cannot happen in zero time, so an instant is not an overlap: reporting one would read as
  // agreement where there is none.
  it("does not count windows that merely touch", () => {
    assert.equal(overlapOf([w("09", "13"), w("13", "17")]), undefined);
  });

  it("returns the one window when only one was given", () => {
    assert.equal(shown(overlapOf([w("09", "17")])), shown(w("09", "17")));
  });

  it("has nothing in common when nobody has answered", () => {
    assert.equal(overlapOf([]), undefined);
  });

  // One operator free all day narrows nothing; the answer is still the tightest pair.
  it("is decided by the tightest window, not the order given", () => {
    const windows = [w("00", "23"), w("14", "16"), w("09", "18")];
    assert.equal(shown(overlapOf(windows)), shown(w("14", "16")));
    assert.equal(shown(overlapOf([...windows].reverse())), shown(w("14", "16")));
  });
});

describe("the largest group that can agree", () => {
  const entry = (keyper: string, from: string, to: string) => ({ keyper, window: w(from, to) });
  const who = (a: { members: readonly { keyper: string }[] } | undefined) =>
    a === undefined ? undefined : a.members.map((m) => m.keyper).sort();

  // The case this exists for: four can meet, one cannot, and the team negotiates with one operator
  // instead of starting over.
  it("finds the group that can meet, and by implication who cannot", () => {
    const found = largestAgreement([
      entry("a", "09", "14"),
      entry("b", "11", "16"),
      entry("c", "10", "13"),
      entry("d", "12", "18"),
      entry("e", "20", "23"),
    ]);
    assert.deepEqual(who(found), ["a", "b", "c", "d"]);
    assert.equal(shown(found?.window), shown(w("12", "13")));
  });

  it("prefers more operators over a wider window", () => {
    const found = largestAgreement([
      entry("a", "09", "17"),
      entry("b", "09", "17"), // two of them, eight hours
      entry("c", "12", "13"),
      entry("d", "12", "13"), // four of them, one hour
    ]);
    assert.equal(who(found)?.length, 4);
    assert.equal(shown(found?.window), shown(w("12", "13")));
  });

  it("prefers the wider window when as many operators agree either way", () => {
    const found = largestAgreement([
      entry("a", "09", "10"),
      entry("b", "09", "10"), // one hour
      entry("c", "14", "18"),
      entry("d", "14", "18"), // four hours
    ]);
    assert.equal(shown(found?.window), shown(w("14", "18")));
  });

  // "1 of 5 overlap" says nothing a list of windows did not already say.
  it("reports nothing when no two of them overlap", () => {
    assert.equal(largestAgreement([entry("a", "09", "10"), entry("b", "14", "15")]), undefined);
    assert.equal(largestAgreement([entry("a", "09", "10")]), undefined);
    assert.equal(largestAgreement([]), undefined);
  });

  it("does not count windows that merely touch", () => {
    assert.equal(largestAgreement([entry("a", "09", "13"), entry("b", "13", "17")]), undefined);
  });

  // When everybody agrees it is simply everybody, so the report needs no separate shape.
  it("is the whole set when the whole set agrees", () => {
    const all = [entry("a", "09", "17"), entry("b", "11", "16"), entry("c", "10", "18")];
    assert.deepEqual(who(largestAgreement(all)), ["a", "b", "c"]);
    assert.equal(shown(largestAgreement(all)?.window), shown(overlapOf(all.map((e) => e.window))));
  });
});
