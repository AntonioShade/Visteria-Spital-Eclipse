import test from "node:test";
import assert from "node:assert/strict";
import { createAccessEntry, parseAmountToCents } from "../lib/access.mjs";

test("converts Romanian decimal input into integer cents", () => {
  assert.equal(parseAmountToCents("125"), 12500);
  assert.equal(parseAmountToCents("12,3"), 1230);
  assert.equal(parseAmountToCents("0.01"), 1);
});

test("rejects zero, negative, malformed, and over-precise amounts", () => {
  for (const amount of ["0", "-1", "1.001", "1e3", "abc", "1000000000"]) {
    assert.throws(() => parseAmountToCents(amount));
  }
});

test("access members require a Discord ID, name, and callsign", () => {
  assert.deepEqual(createAccessEntry({
    discordId: "12345678901234567",
    displayName: "Alex",
    callsign: "A-12"
  }), {
    discordId: "12345678901234567",
    displayName: "Alex",
    callsign: "A-12"
  });
  assert.throws(() => createAccessEntry({ discordId: "abc", displayName: "Alex", callsign: "A-12" }));
  assert.throws(() => createAccessEntry({ discordId: "12345678901234567", displayName: "", callsign: "A-12" }));
  assert.throws(() => createAccessEntry({ discordId: "12345678901234567", displayName: "Alex", callsign: "" }));
});
