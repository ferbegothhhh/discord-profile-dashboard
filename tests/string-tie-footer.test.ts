import assert from "node:assert/strict";
import test from "node:test";
import { FOOTER_DURATION, footerMotion, clamp01, hash, makeRope, nearestFree, polyLength, resample, restPath, scrollProgress, smoothPath, stepRope, stepWind, tiePath } from "../components/ui/string-tie-footer-geometry.ts";

test("footer geometry is deterministic, finite and bounded across envelope sizes", () => {
  for (const [w, h] of [[1, 1], [288, 173], [600, 360], [1200, 700]]) {
    for (const points of [tiePath(w, h), restPath(w, h)]) {
      assert.equal(points.length, 64);
      for (const p of points) {
        assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
        assert.ok(p.x >= 0 && p.x <= w && p.y >= 0 && p.y <= h);
      }
      assert.ok(!/NaN|Infinity/.test(smoothPath(points)));
      assert.ok(polyLength(points) > 0);
    }
  }
  assert.deepEqual(tiePath(), tiePath());
  assert.equal(hash(23), hash(23));
  assert.ok(hash(23) >= 0 && hash(23) < 1);
  assert.equal(clamp01(NaN), 0);
  assert.equal(clamp01(-2), 0);
  assert.equal(clamp01(2), 1);
});

test("footer timeline stages cord, flap and note with continuous reversible easing", () => {
  assert.deepEqual(footerMotion(0), { cord: 0, flap: 0, note: 0 });
  assert.deepEqual(footerMotion(FOOTER_DURATION), { cord: 1, flap: 1, note: 1 });
  assert.equal(footerMotion(400).note, 0);
  assert.equal(footerMotion(400).flap, 0);
  assert.equal(footerMotion(480).cord, 1);
  assert.equal(footerMotion(850).note, 0);
  assert.equal(footerMotion(1000).flap, 1);
  for (let time = 1; time <= FOOTER_DURATION; time++) {
    const previous = footerMotion(time - 1);
    const current = footerMotion(time);
    for (const key of ["cord", "flap", "note"] as const) {
      assert.ok(current[key] >= previous[key]);
      assert.ok(current[key] - previous[key] < .004);
    }
  }
});

test("resampling handles degenerate paths and keeps endpoints", () => {
  assert.deepEqual(resample([], 2), [{ x: 0, y: 0 }, { x: 0, y: 0 }]);
  assert.deepEqual(resample([{ x: 4, y: 5 }], 2), [{ x: 4, y: 5 }, { x: 4, y: 5 }]);
  assert.deepEqual(resample([{ x: 0, y: 0 }, { x: 10, y: 0 }], 3), [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }]);
  assert.equal(smoothPath([]), "");
  assert.equal(scrollProgress(1000, 800, 300), 0);
  assert.equal(scrollProgress(-1000, 800, 300), 1);
  assert.ok(Number.isFinite(scrollProgress(0, 0, 0)));
  assert.equal(stepWind(0), 0);
});

test("rope anchor stays fixed, loose cord drags, brushes and settles", () => {
  const target = restPath();
  let rope = makeRope(tiePath());
  const index = nearestFree(target, target[40], 4);
  assert.ok(index > 0);
  assert.equal(nearestFree(target, { x: -100, y: -100 }), -1);
  const pointer = { x: 550, y: 250 };
  rope = stepRope(rope, target, pointer, 40);
  assert.equal(rope[40].x, pointer.x);
  assert.equal(rope[40].y, pointer.y);
  assert.equal(rope[0].x, target[0].x);
  const brushed = stepRope(makeRope(target), target, { x: target[40].x + 10, y: target[40].y });
  assert.notEqual(brushed[40].x, target[40].x);
  for (let i = 0; i < 150; i++) rope = stepRope(rope, target);
  for (let i = 0; i < rope.length; i++) assert.ok(Math.hypot(rope[i].x - target[i].x, rope[i].y - target[i].y) < .01);
});
