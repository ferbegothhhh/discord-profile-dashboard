import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { ImageProcessingError, MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, MAX_OUTPUT_BYTES, processImage, readImageStream } from "../lib/image-processing.ts";

const fixture = () => sharp({ create: { width: 80, height: 60, channels: 3, background: "#347856" } });
function code(expected: string) {
  return (error: unknown) => {
    assert.ok(error instanceof ImageProcessingError);
    assert.equal(error.code, expected);
    assert.equal(error.message, expected);
    assert.equal(error.cause, undefined);
    return true;
  };
}

test("static JPEG, PNG and WebP become bounded 1000x560 PNG", async () => {
  for (const format of ["jpeg", "png", "webp"] as const) {
    const input = await fixture()[format]().toBuffer();
    const output = await processImage(input, `image/${format}`);
    const metadata = await sharp(output).metadata();
    assert.equal(metadata.format, "png");
    assert.equal(metadata.width, 1000);
    assert.equal(metadata.height, 560);
    assert.ok(output.length <= MAX_OUTPUT_BYTES);
  }
});

test("empty, oversized, unsupported signatures and forged MIME are rejected", async () => {
  await assert.rejects(processImage(Buffer.alloc(0), "image/png"), code("invalid_image"));
  await assert.rejects(processImage(Buffer.alloc(MAX_IMAGE_BYTES + 1), "image/png"), code("image_too_large"));
  for (const input of [Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), Buffer.from("GIF89a"), await fixture().tiff().toBuffer()]) {
    await assert.rejects(processImage(input, "image/png"), code("unsupported_image"));
  }
  const png = await fixture().png().toBuffer();
  for (const mime of ["image/jpeg", "image/svg+xml", "", "image/png; charset=utf-8"]) await assert.rejects(processImage(png, mime), code("unsupported_image"));
});

test("truncated containers and corrupt compressed image data fail without decoder leaks", async () => {
  for (const format of ["jpeg", "png", "webp"] as const) {
    const input = await fixture()[format]().toBuffer();
    await assert.rejects(processImage(input.subarray(0, input.length - 10), `image/${format}`), code("invalid_image"));
  }
  const png = await fixture().png().toBuffer();
  const idat = png.indexOf(Buffer.from("IDAT"));
  png.fill(0xff, idat + 4, idat + 12);
  await assert.rejects(processImage(png, "image/png"), code("invalid_image"));
  const fake = Buffer.from([255, 216, 255, 0, 0, 0, 255, 217]);
  await assert.rejects(processImage(fake, "image/jpeg"), code("invalid_image"));
});

test("animated WebP and PNG animation chunks are rejected", async () => {
  const frames = Buffer.concat([Buffer.alloc(20 * 20 * 3, 0), Buffer.alloc(20 * 20 * 3, 255)]);
  const animated = await sharp(frames, { raw: { width: 20, height: 40, channels: 3, pageHeight: 20 } }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
  assert.equal((await sharp(animated, { animated: true }).metadata()).pages, 2);
  await assert.rejects(processImage(animated, "image/webp"), code("animated_image"));
  const png = await fixture().png().toBuffer();
  const chunk = Buffer.alloc(20);
  chunk.writeUInt32BE(8, 0); chunk.write("acTL", 4); chunk.writeUInt32BE(2, 8);
  await assert.rejects(processImage(Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]), "image/png"), code("animated_image"));
});

test("decoded pixel cap rejects small compressed bombs and releases the guard", async () => {
  const input = await sharp({ create: { width: 4001, height: 4000, channels: 3, background: "white" } }).png().toBuffer();
  assert.ok(4001 * 4000 > MAX_IMAGE_PIXELS);
  assert.ok(input.length < MAX_IMAGE_BYTES);
  await assert.rejects(processImage(input, "image/png"), code("invalid_image"));
  await processImage(await fixture().png().toBuffer(), "image/png");
});

test("concurrent processing fails busy rather than queueing", async () => {
  const input = await fixture().png().toBuffer();
  const first = processImage(input, "image/png");
  await assert.rejects(processImage(input, "image/png"), code("image_busy"));
  await first;
  await processImage(input, "image/png");
});

test("EXIF orientation is applied and EXIF, ICC and XMP metadata are stripped", async () => {
  const input = await sharp({ create: { width: 560, height: 1000, channels: 3, background: "red" } })
    .composite([{ input: await sharp({ create: { width: 560, height: 500, channels: 3, background: "blue" } }).png().toBuffer(), left: 0, top: 0 }])
    .withMetadata({ orientation: 6 }).withXmp("<x:xmpmeta xmlns:x='adobe:ns:meta/'>private</x:xmpmeta>").jpeg().toBuffer();
  const before = await sharp(input).metadata();
  assert.ok(before.exif); assert.ok(before.icc); assert.ok(before.xmp);
  const output = await processImage(input, "image/jpeg");
  const after = await sharp(output).metadata();
  for (const key of ["exif", "icc", "xmp", "iptc", "orientation"] as const) assert.equal(after[key], undefined);
  const { data, info } = await sharp(output).raw().toBuffer({ resolveWithObject: true });
  const left = (280 * info.width + 100) * info.channels;
  const right = (280 * info.width + 900) * info.channels;
  assert.ok(data[left] > 200 && data[left + 2] < 30);
  assert.ok(data[right + 2] > 200 && data[right] < 30);
});

test("cover uses the center crop rather than stretching or an edge crop", async () => {
  const center = await sharp({ create: { width: 1000, height: 560, channels: 3, background: "lime" } }).png().toBuffer();
  const input = await sharp({ create: { width: 2000, height: 560, channels: 3, background: "red" } }).composite([{ input: center, left: 500, top: 0 }]).png().toBuffer();
  const output = await processImage(input, "image/png");
  const stats = await sharp(output).stats();
  assert.equal(stats.channels[0].max, 0);
  assert.equal(stats.channels[1].min, 255);
  assert.equal(stats.channels[2].max, 0);
});

test("stream reader copies chunks, permits exactly 3 MiB and cancels overflow", async () => {
  const exact = await readImageStream(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_IMAGE_BYTES)); controller.close(); } }));
  assert.equal(exact.length, MAX_IMAGE_BYTES);
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(MAX_IMAGE_BYTES)); controller.enqueue(new Uint8Array(1)); }, cancel() { cancelled = true; } });
  await assert.rejects(readImageStream(stream), code("image_too_large"));
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
});

test("stream deadlines cancel stalled reads and stream failures are sanitized", async () => {
  let cancelled = false;
  const stalled = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; return new Promise(() => {}); } });
  await assert.rejects(readImageStream(stalled, 20), code("image_read_timeout"));
  assert.equal(cancelled, true);
  assert.equal(stalled.locked, false);
  await assert.rejects(readImageStream(new ReadableStream({ start(controller) { controller.error(new Error("private decoder details")); } })), code("image_read_failed"));
  await assert.rejects(readImageStream(new ReadableStream({ start(controller) { controller.close(); } })), code("invalid_image"));
});
