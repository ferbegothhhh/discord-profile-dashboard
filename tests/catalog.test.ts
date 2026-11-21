import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { backgrounds, defaultBackgroundId, filterBackgrounds, findBackground, isCatalog, parseDraft, serializeDraft } from "../lib/catalog.ts";

function contrast(first: string, second: string) {
  function luminance(hex: string) {
    const channels = hex.slice(1).match(/.{2}/g)!.map((channel) => {
      const value = parseInt(channel, 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  }
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test("design tokens preserve AA text and control contrast", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  const token = (name: string) => {
    const value = css.match(new RegExp(`--${name}: (#[0-9a-f]{6});`, "i"))?.[1];
    assert.ok(value, `Missing color token ${name}`);
    return value;
  };
  const surfaces = [token("background"), token("surface"), "#303036", "#414148"];
  for (const surface of surfaces) {
    for (const text of [token("text"), token("muted")]) assert.ok(contrast(text, surface) >= 4.5, `${text} on ${surface}`);
    assert.ok(contrast(token("border"), surface) >= 3);
    assert.ok(contrast(token("selected"), surface) >= 3);
  }
  for (const surface of [token("accent"), token("color-primary-hover"), token("color-primary-active")]) assert.ok(contrast("#ffffff", surface) >= 4.5);
  for (const item of backgrounds) assert.ok(contrast(token("text"), item.color) >= 4.5);
});

test("draft round-trip only accepts allowed sample IDs", () => {
  for (const item of backgrounds) assert.equal(parseDraft(serializeDraft(item.id)), item.id);
  assert.throws(() => serializeDraft("../../private"));
  assert.equal(findBackground(defaultBackgroundId)?.name, "Karbon");
});

test("missing, corrupt, oversized and obsolete drafts are rejected", () => {
  for (const raw of [null, "{", "null", "[]", "{}", "x".repeat(513), '{"version":2,"backgroundId":"sample-carbon"}', '{"version":1,"backgroundId":"unknown"}', '{"version":1,"backgroundId":123}']) assert.equal(parseDraft(raw), null);
});

test("search trims, ignores case, and combines with category", () => {
  assert.deepEqual(filterBackgrounds(backgrounds, "  VIOLET ", "Ungu").map((item) => item.id), ["sample-violet"]);
  assert.equal(filterBackgrounds(backgrounds, "violet", "Netral").length, 0);
  assert.equal(filterBackgrounds(backgrounds, "", "Semua").length, backgrounds.length);
  assert.equal(filterBackgrounds([], "", "Semua").length, 0);
});

test("catalog rejects forged content and duplicate IDs, allows empty state", () => {
  assert.equal(isCatalog({ backgrounds }), true);
  assert.equal(isCatalog({ backgrounds: [] }), true);
  for (const value of [null, {}, { backgrounds: [null] }, { backgrounds: [backgrounds[0], backgrounds[0]] }, { backgrounds: [{ ...backgrounds[0], color: "url(private)" }] }, { backgrounds: [{ ...backgrounds[0], id: "unknown" }] }]) assert.equal(isCatalog(value), false);
});
