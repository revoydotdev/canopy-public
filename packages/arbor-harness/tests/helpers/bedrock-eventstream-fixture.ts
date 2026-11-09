/**
 * Test-only encoder for AWS's `application/vnd.amazon.eventstream` framing.
 *
 * Production code (`bedrock-messages.ts`) only ever *decodes* this format --
 * real Bedrock responses arrive already framed by AWS's own servers, so
 * `../../src/bedrock-eventstream.ts` exports a decoder only
 * (`drainEventStreamMessages`), which keeps it a real, reachable export
 * (`gate:reachability` treats an export with no production caller as dead
 * code). This helper is the encoder half, kept in `tests/` on purpose so
 * `bedrock-eventstream.test.ts` and `bedrock-messages.test.ts` can build
 * real, CRC-valid frames as fetch-stub fixtures instead of hand-waving the
 * wire format under test -- see `bedrock-eventstream.ts`'s own module doc
 * for the frame layout this mirrors.
 */

const HEADER_VALUE_TYPE_STRING = 7;
const CRC_TABLE = buildCrc32Table();

export class BedrockEventStreamFixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BedrockEventStreamFixtureError";
  }
}

export function encodeEventStreamMessage(headers: ReadonlyMap<string, string>, payload: Uint8Array): Uint8Array {
  const encoder = new TextEncoder();
  const headerChunks: Uint8Array[] = [];
  for (const [name, value] of headers) {
    const nameBytes = encoder.encode(name);
    const valueBytes = encoder.encode(value);
    if (nameBytes.length > 255) throw new BedrockEventStreamFixtureError("eventstream header name exceeds 255 bytes");
    const chunk = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
    let o = 0;
    chunk[o] = nameBytes.length; o += 1;
    chunk.set(nameBytes, o); o += nameBytes.length;
    chunk[o] = HEADER_VALUE_TYPE_STRING; o += 1;
    new DataView(chunk.buffer).setUint16(o, valueBytes.length, false); o += 2;
    chunk.set(valueBytes, o);
    headerChunks.push(chunk);
  }
  const headerBytes = concatBytes(headerChunks);
  const totalLength = 12 + headerBytes.length + payload.length + 4;
  const prelude = new Uint8Array(12);
  const preludeView = new DataView(prelude.buffer);
  preludeView.setUint32(0, totalLength, false);
  preludeView.setUint32(4, headerBytes.length, false);
  preludeView.setUint32(8, crc32(prelude.subarray(0, 8)), false);
  const withoutMessageCrc = concatBytes([prelude, headerBytes, payload]);
  const messageCrc = new Uint8Array(4);
  new DataView(messageCrc.buffer).setUint32(0, crc32(withoutMessageCrc), false);
  return concatBytes([withoutMessageCrc, messageCrc]);
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

/** CRC32 (ISO-HDLC / zlib polynomial) -- reimplemented here rather than importing the private one in `bedrock-eventstream.ts`, since that module intentionally exports nothing but its decoder. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
}
