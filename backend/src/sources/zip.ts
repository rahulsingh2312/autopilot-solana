/**
 * Minimal ZIP reader, on Node's built-in zlib.
 *
 * The House Clerk publishes its disclosure index as a ZIP, and that is the
 * only archive this worker ever opens. A dependency to read two files — where
 * one of them is the input to a pipeline that moves money — is a worse trade
 * than sixty lines that only support what we actually need.
 *
 * Entries are located through the central directory rather than by scanning
 * for local headers: local headers may carry zeroed sizes with the real values
 * in a trailing data descriptor, and the central directory always has them.
 */

import { inflateRawSync } from "node:zlib";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;

export type ZipEntry = { name: string; data: Buffer };

/** Locates the end-of-central-directory record, scanning back over any comment. */
function findEocd(buffer: Buffer): number {
  const minimum = 22;
  const start = Math.max(0, buffer.length - (minimum + 0xffff));
  for (let i = buffer.length - minimum; i >= start; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new Error("not a zip archive: no end-of-central-directory record");
}

export function readZip(buffer: Buffer): ZipEntry[] {
  const eocd = findEocd(buffer);
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  const entries: ZipEntry[] = [];

  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new Error(`corrupt zip: bad central directory entry at ${offset}`);
    }

    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);

    // The local header repeats the name and extra fields, and its extra field
    // length can differ from the central one — so it must be read, not assumed.
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);

    if (method === METHOD_STORED) {
      entries.push({ name, data: Buffer.from(raw) });
    } else if (method === METHOD_DEFLATED) {
      entries.push({ name, data: inflateRawSync(raw) });
    } else {
      throw new Error(`unsupported zip compression method ${method} for ${name}`);
    }

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}
