import sharp from "sharp";

export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 16_000_000;
export const IMAGE_WIDTH = 1000;
export const IMAGE_HEIGHT = 560;
export const MAX_OUTPUT_BYTES = IMAGE_WIDTH * IMAGE_HEIGHT * 4 + 65536;
export const IMAGE_READ_TIMEOUT_MS = 5000;

export type ImageErrorCode = "image_too_large" | "unsupported_image" | "invalid_image" | "animated_image" | "image_busy" | "image_read_timeout" | "image_read_failed" | "image_output_too_large";
export class ImageProcessingError extends Error {
  readonly code: ImageErrorCode;
  constructor(code: ImageErrorCode) { super(code); this.name = "ImageProcessingError"; this.code = code; }
}

type ImageFormat = "jpeg" | "png" | "webp";
const mimeTypes: Record<ImageFormat, string> = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
let processing = false;

function inspectSignature(input: Buffer): ImageFormat {
  if (input.length >= 3 && input[0] === 0xff && input[1] === 0xd8 && input[2] === 0xff) {
    if (input.length < 4 || input.readUInt16BE(input.length - 2) !== 0xffd9) throw new ImageProcessingError("invalid_image");
    return "jpeg";
  }
  if (input.length >= 8 && input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    let offset = 8;
    let ended = false;
    while (offset < input.length) {
      if (input.length - offset < 12) throw new ImageProcessingError("invalid_image");
      const length = input.readUInt32BE(offset);
      const type = input.toString("ascii", offset + 4, offset + 8);
      if (length > input.length - offset - 12) throw new ImageProcessingError("invalid_image");
      if (["acTL", "fcTL", "fdAT"].includes(type)) throw new ImageProcessingError("animated_image");
      offset += length + 12;
      if (type === "IEND") { ended = length === 0 && offset === input.length; break; }
    }
    if (!ended) throw new ImageProcessingError("invalid_image");
    return "png";
  }
  if (input.length >= 12 && input.toString("ascii", 0, 4) === "RIFF" && input.toString("ascii", 8, 12) === "WEBP") {
    if (input.readUInt32LE(4) !== input.length - 8) throw new ImageProcessingError("invalid_image");
    let offset = 12;
    while (offset < input.length) {
      if (input.length - offset < 8) throw new ImageProcessingError("invalid_image");
      const type = input.toString("ascii", offset, offset + 4);
      const length = input.readUInt32LE(offset + 4);
      if (length > input.length - offset - 8) throw new ImageProcessingError("invalid_image");
      if (type === "ANIM" || type === "ANMF" || (type === "VP8X" && length > 0 && (input[offset + 8] & 2) !== 0)) throw new ImageProcessingError("animated_image");
      offset += 8 + length + (length % 2);
    }
    if (offset !== input.length) throw new ImageProcessingError("invalid_image");
    return "webp";
  }
  throw new ImageProcessingError("unsupported_image");
}

export async function processImage(input: Buffer, contentType: string): Promise<Buffer> {
  if (processing) throw new ImageProcessingError("image_busy");
  if (!Buffer.isBuffer(input) || !input.length) throw new ImageProcessingError("invalid_image");
  if (input.length > MAX_IMAGE_BYTES) throw new ImageProcessingError("image_too_large");
  processing = true;
  let pipeline: ReturnType<typeof sharp> | undefined;
  try {
    const source = Buffer.from(input);
    const format = inspectSignature(source);
    if (contentType !== mimeTypes[format]) throw new ImageProcessingError("unsupported_image");
    pipeline = sharp(source, { failOn: "warning", limitInputPixels: MAX_IMAGE_PIXELS, sequentialRead: true });
    const metadata = await pipeline.metadata();
    if (metadata.format !== format || !metadata.width || !metadata.height || metadata.width * metadata.height > MAX_IMAGE_PIXELS) throw new ImageProcessingError("invalid_image");
    if ((metadata.pages ?? 1) !== 1 || (metadata.delay?.length ?? 0) > 0) throw new ImageProcessingError("animated_image");
    const output = await pipeline.rotate().resize(IMAGE_WIDTH, IMAGE_HEIGHT, { fit: "cover", position: "centre" }).toColourspace("srgb").png({ compressionLevel: 9, progressive: false, palette: false }).timeout({ seconds: 5 }).toBuffer();
    if (output.length > MAX_OUTPUT_BYTES) throw new ImageProcessingError("image_output_too_large");
    return output;
  } catch (error) {
    if (error instanceof ImageProcessingError) throw error;
    throw new ImageProcessingError("invalid_image");
  } finally {
    pipeline?.destroy();
    processing = false;
  }
}

export async function readImageStream(stream: ReadableStream<Uint8Array>, timeoutMs = IMAGE_READ_TIMEOUT_MS): Promise<Buffer> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > IMAGE_READ_TIMEOUT_MS) throw new ImageProcessingError("image_read_failed");
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try { reader = stream.getReader(); } catch { throw new ImageProcessingError("image_read_failed"); }
  const chunks: Buffer[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ImageProcessingError("image_read_timeout")), timeoutMs);
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new ImageProcessingError("image_read_failed");
      size += value.byteLength;
      if (size > MAX_IMAGE_BYTES) throw new ImageProcessingError("image_too_large");
      chunks.push(Buffer.from(value));
    }
    if (!size) throw new ImageProcessingError("invalid_image");
    return Buffer.concat(chunks, size);
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (error instanceof ImageProcessingError) throw error;
    throw new ImageProcessingError("image_read_failed");
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}
