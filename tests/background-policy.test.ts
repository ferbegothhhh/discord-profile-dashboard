import assert from "node:assert/strict";
import { test } from "node:test";
import { canUseCustomSlot, customSlotCount, customSlots, isCustomSlot } from "../lib/background-policy.ts";

const userId = "123456789012345678";
const guildId = "1540196599320285255";

test("custom slots open at current guild levels 20, 45 and 65 and never exceed three", () => {
  for (const [level, count] of [[0, 0], [10, 0], [19, 0], [20, 1], [35, 1], [44, 1], [45, 2], [55, 2], [64, 2], [65, 3], [75, 3], [1000, 3]]) {
    assert.equal(customSlotCount(level), count);
  }
});

test("invalid or missing current level fails closed", () => {
  for (const value of [undefined, null, "65", -1, 20.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, {}]) assert.equal(customSlotCount(value), 0);
  assert.equal(canUseCustomSlot(null, userId, guildId, 1), false);
});

test("slot eligibility is bound to both user and guild", () => {
  const snapshot = { userId, guildId, level: 65 };
  assert.equal(canUseCustomSlot(snapshot, userId, guildId, 3), true);
  assert.equal(canUseCustomSlot(snapshot, "223456789012345678", guildId, 1), false);
  assert.equal(canUseCustomSlot(snapshot, userId, "223456789012345678", 1), false);
  assert.equal(canUseCustomSlot({ ...snapshot, userId: "invalid" }, "invalid", guildId, 1), false);
  for (const slot of [0, 4, 1.5, "1", null, undefined]) {
    assert.equal(isCustomSlot(slot), false);
    assert.equal(canUseCustomSlot(snapshot, userId, guildId, slot), false);
  }
});

test("level drops lock stable slots without renumbering or mutating previous state", () => {
  const snapshot = { userId, guildId, level: 65 };
  const before = customSlots(snapshot, userId, guildId);
  const after = customSlots({ ...snapshot, level: 20 }, userId, guildId);
  assert.deepEqual(before.map((slot) => slot.unlocked), [true, true, true]);
  assert.deepEqual(after, [
    { slot: 1, requiredLevel: 20, unlocked: true },
    { slot: 2, requiredLevel: 45, unlocked: false },
    { slot: 3, requiredLevel: 65, unlocked: false },
  ]);
  assert.deepEqual(customSlots({ ...snapshot, level: 0 }, userId, guildId).map((slot) => slot.unlocked), [false, false, false]);
  assert.deepEqual(customSlots(snapshot, userId, guildId), before);
  assert.equal(snapshot.level, 65);
});
