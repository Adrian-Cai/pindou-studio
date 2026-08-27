import { inflateSync } from "node:zlib";
import { extname } from "node:path";
import { invalidArgument } from "../../shared/app-error";

export interface ValidatedImage {
  readonly extension: "jpg" | "png" | "webp";
  readonly contentType: "image/jpeg" | "image/png" | "image/webp";
  readonly width: number;
  readonly height: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function validateCoverImage(
  buffer: Buffer,
  filename: string,
  declaredContentType: string,
): ValidatedImage {
  const image = detectAndValidateImage(buffer);
  const extension = extname(filename).toLowerCase();
  const allowedExtensions = image.extension === "jpg" ? [".jpg", ".jpeg"] : [`.${image.extension}`];
  if (!allowedExtensions.includes(extension)) {
    throw invalidArgument("封面文件扩展名与真实图片格式不匹配");
  }

  const declared = declaredContentType.trim().toLowerCase();
  if (declared && declared !== "application/octet-stream" && declared !== image.contentType) {
    throw invalidArgument("封面文件 MIME 类型与真实图片格式不匹配");
  }
  return image;
}

function detectAndValidateImage(buffer: Buffer): ValidatedImage {
  if (buffer.length >= PNG_SIGNATURE.length && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return validatePng(buffer);
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return validateJpeg(buffer);
  }
  if (
    buffer.length >= 12
    && buffer.subarray(0, 4).toString("ascii") === "RIFF"
    && buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return validateWebp(buffer);
  }
  throw invalidArgument("封面必须是可解码的 JPG、PNG 或 WEBP 图片");
}

function dimensions(width: number, height: number, format: ValidatedImage["extension"]): ValidatedImage {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 16_384 || height > 16_384) {
    throw invalidArgument("封面图片尺寸不合法");
  }
  const contentType = format === "jpg" ? "image/jpeg" : `image/${format}` as ValidatedImage["contentType"];
  return { extension: format, contentType, width, height };
}

function validatePng(buffer: Buffer): ValidatedImage {
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let sawIdat = false;
  let sawIend = false;
  let sawPalette = false;
  const compressed: Buffer[] = [];
  let previousChunk = "";

  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (dataEnd < dataStart || chunkEnd > buffer.length) throw invalidArgument("封面 PNG 文件不完整");
    const data = buffer.subarray(dataStart, dataEnd);
    if (crc32(Buffer.concat([Buffer.from(type, "ascii"), data])) !== buffer.readUInt32BE(dataEnd)) {
      throw invalidArgument("封面 PNG 文件校验失败");
    }
    if (previousChunk === "IEND") throw invalidArgument("封面 PNG 文件包含无效数据");

    if (!previousChunk && type !== "IHDR") throw invalidArgument("封面 PNG 缺少 IHDR 数据");
    if (type === "IHDR") {
      if (length !== 13 || width !== 0) throw invalidArgument("封面 PNG IHDR 数据不合法");
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8] ?? 0;
      colorType = data[9] ?? 0;
      if (data[10] !== 0 || data[11] !== 0 || data[12] === undefined) throw invalidArgument("封面 PNG IHDR 数据不合法");
      interlace = data[12];
      if (interlace !== 0 || !validPngBitDepth(colorType, bitDepth)) {
        throw invalidArgument("封面 PNG 编码格式暂不支持");
      }
    } else if (type === "IDAT") {
      sawIdat = true;
      compressed.push(data);
    } else if (type === "PLTE") {
      if (length === 0 || length % 3 !== 0 || length / 3 > 256) throw invalidArgument("封面 PNG 调色板数据不合法");
      sawPalette = true;
    } else if (type === "IEND") {
      if (length !== 0 || !sawIdat) throw invalidArgument("封面 PNG 缺少图像数据");
      sawIend = true;
    }

    previousChunk = type;
    offset = chunkEnd;
    if (sawIend) break;
  }

  if (!sawIend || offset !== buffer.length || width === 0 || height === 0) {
    throw invalidArgument("封面 PNG 文件不完整");
  }
  if (colorType === 3 && !sawPalette) throw invalidArgument("封面 PNG 缺少调色板");
  let decoded: Buffer;
  try {
    decoded = inflateSync(Buffer.concat(compressed));
  } catch {
    throw invalidArgument("封面 PNG 图片无法解码");
  }
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : 4;
  const rowBytes = Math.ceil(width * channels * bitDepth / 8);
  if (decoded.length !== height * (rowBytes + 1)) throw invalidArgument("封面 PNG 图片无法解码");
  for (let row = 0; row < height; row += 1) {
    if (decoded[row * (rowBytes + 1)]! > 4) throw invalidArgument("封面 PNG 图片无法解码");
  }
  return dimensions(width, height, "png");
}

function validPngBitDepth(colorType: number, bitDepth: number): boolean {
  if (colorType === 0) return [1, 2, 4, 8, 16].includes(bitDepth);
  if (colorType === 2 || colorType === 4 || colorType === 6) return bitDepth === 8 || bitDepth === 16;
  return colorType === 3 && [1, 2, 4, 8].includes(bitDepth);
}

function validateJpeg(buffer: Buffer): ValidatedImage {
  let offset = 2;
  let width = 0;
  let height = 0;
  while (offset + 1 < buffer.length) {
    if (buffer[offset++] !== 0xff) throw invalidArgument("封面 JPEG 图片无法解码");
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset++];
    if (marker === undefined) break;
    if (marker === 0xda) {
      const length = readJpegSegmentLength(buffer, offset);
      if (length < 2 || offset + length > buffer.length) throw invalidArgument("封面 JPEG 文件不完整");
      offset += length;
      if (!hasJpegEndOfScan(buffer, offset)) throw invalidArgument("封面 JPEG 图片无法解码");
      break;
    }
    if (marker === 0xd9) break;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const length = readJpegSegmentLength(buffer, offset);
    if (length < 2 || offset + length > buffer.length) throw invalidArgument("封面 JPEG 文件不完整");
    if (isJpegFrameMarker(marker)) {
      if (length < 7) throw invalidArgument("封面 JPEG 尺寸数据不合法");
      height = buffer.readUInt16BE(offset + 3);
      width = buffer.readUInt16BE(offset + 5);
    }
    offset += length;
  }
  if (width === 0 || height === 0 || !buffer.subarray(-2).equals(Buffer.from([0xff, 0xd9]))) {
    throw invalidArgument("封面 JPEG 图片无法解码");
  }
  return dimensions(width, height, "jpg");
}

function hasJpegEndOfScan(buffer: Buffer, offset: number): boolean {
  let sawEntropy = false;
  for (let index = offset; index + 1 < buffer.length; index += 1) {
    if (buffer[index] !== 0xff) {
      sawEntropy = true;
      continue;
    }
    let markerIndex = index + 1;
    while (markerIndex < buffer.length && buffer[markerIndex] === 0xff) markerIndex += 1;
    const marker = buffer[markerIndex];
    if (marker === 0 || (marker !== undefined && marker >= 0xd0 && marker <= 0xd7)) {
      index = markerIndex;
      continue;
    }
    if (marker === 0xd9) return sawEntropy;
  }
  return false;
}

function readJpegSegmentLength(buffer: Buffer, offset: number): number {
  if (offset + 2 > buffer.length) throw invalidArgument("封面 JPEG 文件不完整");
  return buffer.readUInt16BE(offset);
}

function isJpegFrameMarker(marker: number): boolean {
  return (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)
    || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
}

function validateWebp(buffer: Buffer): ValidatedImage {
  const declaredSize = buffer.readUInt32LE(4) + 8;
  if (declaredSize > buffer.length) throw invalidArgument("封面 WEBP 文件不完整");
  let offset = 12;
  while (offset + 8 <= declaredSize) {
    const type = buffer.subarray(offset, offset + 4).toString("ascii");
    const size = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + size;
    if (dataEnd < dataStart || dataEnd > declaredSize) throw invalidArgument("封面 WEBP 文件不完整");
    const data = buffer.subarray(dataStart, dataEnd);
    if (type === "VP8 ") {
      if (data.length < 10 || data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a) throw invalidArgument("封面 WEBP 图片无法解码");
      return dimensions(data.readUInt16LE(6) & 0x3fff, data.readUInt16LE(8) & 0x3fff, "webp");
    }
    if (type === "VP8L") {
      if (data.length < 5 || data[0] !== 0x2f) throw invalidArgument("封面 WEBP 图片无法解码");
      const width = 1 + (data[1]! | ((data[2]! & 0x3f) << 8));
      const height = 1 + ((data[2]! >> 6) | (data[3]! << 2) | ((data[4]! & 0x0f) << 10));
      return dimensions(width, height, "webp");
    }
    if (type === "VP8X") {
      if (data.length < 10) throw invalidArgument("封面 WEBP 图片无法解码");
      const width = 1 + data[4]! + (data[5]! << 8) + (data[6]! << 16);
      const height = 1 + data[7]! + (data[8]! << 8) + (data[9]! << 16);
      return dimensions(width, height, "webp");
    }
    offset = dataEnd + (size % 2);
  }
  throw invalidArgument("封面 WEBP 图片无法解码");
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
