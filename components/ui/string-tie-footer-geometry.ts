export type Point = { x: number; y: number };
export type RopePoint = Point & { px: number; py: number };

export const clamp01 = (n: number) => Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
export function hash(n: number) {
  const value = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return value - Math.floor(value);
}
export function polyLength(points: readonly Point[]) {
  return points.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - points[i].x, p.y - points[i].y), 0);
}
export function resample(points: readonly Point[], count = 64): Point[] {
  const size = Math.max(2, Math.floor(Number.isFinite(count) ? count : 64));
  if (!points.length) return Array.from({ length: size }, () => ({ x: 0, y: 0 }));
  const total = polyLength(points);
  if (!total) return Array.from({ length: size }, () => ({ ...points[0] }));
  let segment = 1;
  let walked = 0;
  return Array.from({ length: size }, (_, i) => {
    const distance = total * i / (size - 1);
    while (segment < points.length - 1 && walked + Math.hypot(points[segment].x - points[segment - 1].x, points[segment].y - points[segment - 1].y) < distance) {
      walked += Math.hypot(points[segment].x - points[segment - 1].x, points[segment].y - points[segment - 1].y);
      segment++;
    }
    const a = points[segment - 1];
    const b = points[segment];
    const t = clamp01((distance - walked) / Math.max(0.00001, Math.hypot(b.x - a.x, b.y - a.y)));
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  });
}
export function tiePath(width = 600, height = 360, turns = 2): Point[] {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const points: Point[] = [{ x: w * .5, y: h * .72 }];
  for (let i = 0; i <= 180; i++) {
    const t = i / 180 * Math.PI * 2 * Math.max(1, turns);
    points.push({ x: w * .5 + Math.sin(t * 2) * w * .065, y: h * .525 + Math.cos(t) * h * .195 });
  }
  points.push({ x: w * .6, y: h * .79 }, { x: w * .67, y: h * .85 });
  return resample(points);
}
export function restPath(width = 600, height = 360): Point[] {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  return resample(Array.from({ length: 65 }, (_, i) => {
    const t = i / 64;
    return { x: w * (.5 + .34 * t + .04 * Math.sin(t * 7)), y: h * (.72 + .2 * t + .035 * Math.sin(t * 10)) };
  }));
}
export function smoothPath(points: readonly Point[]) {
  if (!points.length) return "";
  let path = `M ${points[0].x.toFixed(3)} ${points[0].y.toFixed(3)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    const next = points[i + 1];
    path += ` Q ${p.x.toFixed(3)} ${p.y.toFixed(3)} ${((p.x + next.x) / 2).toFixed(3)} ${((p.y + next.y) / 2).toFixed(3)}`;
  }
  const last = points[points.length - 1];
  return `${path} L ${last.x.toFixed(3)} ${last.y.toFixed(3)}`;
}
export function scrollProgress(top: number, viewport: number, height: number) {
  return clamp01((viewport - top) / Math.max(1, viewport * .45 + height * .2));
}
export const FOOTER_DURATION = 1500;
export function footerMotion(time: number) {
  const ease = (start: number, duration: number) => {
    const t = clamp01((time - start) / duration);
    return t * t * t * (t * (t * 6 - 15) + 10);
  };
  return { cord: ease(0, 480), flap: ease(400, 600), note: ease(850, 650) };
}
export function stepWind(time: number, strength = 1) {
  return (Math.sin(time * .0013) + Math.sin(time * .0027) * .4) * strength;
}
export function makeRope(points: readonly Point[]): RopePoint[] {
  return points.map(p => ({ ...p, px: p.x, py: p.y }));
}
export function nearestFree(points: readonly Point[], pointer: Point, radius = 60) {
  let nearest = -1;
  let distance = radius;
  for (let i = 1; i < points.length; i++) {
    const d = Math.hypot(points[i].x - pointer.x, points[i].y - pointer.y);
    if (d < distance) { nearest = i; distance = d; }
  }
  return nearest;
}
export function stepRope(rope: readonly RopePoint[], target: readonly Point[], pointer: Point | null = null, held = -1, wind = 0): RopePoint[] {
  return rope.map((p, i) => {
    const goal = target[i] ?? target[target.length - 1] ?? p;
    if (i === 0) return { ...goal, px: goal.x, py: goal.y };
    const brush = pointer ? Math.max(0, 1 - Math.hypot(p.x - pointer.x, p.y - pointer.y) / 65) : 0;
    const x = held === i && pointer ? pointer.x : p.x + (p.x - p.px) * .76 + (goal.x - p.x) * .12 + wind * .08 + (pointer ? (p.x - pointer.x) * brush * .08 : 0);
    const y = held === i && pointer ? pointer.y : p.y + (p.y - p.py) * .76 + (goal.y - p.y) * .12 + (pointer ? (p.y - pointer.y) * brush * .08 : 0);
    return { x, y, px: p.x, py: p.y };
  });
}
