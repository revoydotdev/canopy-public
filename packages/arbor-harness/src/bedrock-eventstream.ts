/**
 * Decoder for AWS's binary `application/vnd.amazon.eventstream` framing,
 * which `InvokeModelWithResponseStream` always uses for its response body
 * (https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_InvokeModelWithResponseStream.html,
 * fetched 2026-08-26: response `Content-Type` is always
 * `application/vnd.amazon.eventstream`; each event's JSON payload arrives
 * as `{"chunk": {"bytes": <base64>}}` or one of the named exception
 * shapes). This module is the framing layer only -- decoding one message's
 * `:event-type`/`:message-type` headers and payload bytes. `bedrock-messages.ts`
 * interprets the decoded payload as the Anthropic Messages-shaped JSON body
 * documented at
 * https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-anthropic-claude-messages.html.
 *
 * Frame layout (four big-endian uint32/CRC32 fields plus variable
 * sections), reproduced from the wire format AWS's own SDKs implement --
 * there is no published "vendor SDK" dependency here, only the on-the-wire
 * byte layout every AWS eventstream client (S3 Select, Transcribe,
 * Kinesis, Bedrock) implements identically:
 *
 *   total_length   (4 bytes, includes everything below)
 *   headers_length (4 bytes)
 *   prelude_crc    (4 bytes, CRC32 of the two length fields above)
 *   headers        (headers_length bytes)
 *   payload        (total_length - 12 - headers_length - 4 bytes)
 *   message_crc    (4 bytes, CRC32 of everything from total_length through payload)
 *
 * Each header is `{ name_len: u8, name: utf8, value_type: u8, ...value }`.
 * Only the string value type (7) is required for Bedrock's own headers
 * (`:message-type`, `:event-type`, `:content-type`, `:exception-type`).
 */

export interface DecodedEventStreamMessage {
  readonly headers: ReadonlyMap<string, string>;
  readonly payload: Uint8Array;
}

export class BedrockEventStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BedrockEventStreamError";
  }
}

const HEADER_VALUE_TYPE_STRING = 7;
const CRC_TABLE = buildCrc32Table();

/**
 * Consumes complete frames from `buffer`, returning the decoded messages
 * plus the unconsumed remainder (a partial trailing frame, kept for the
 * next chunk). Never mutates its input.
 */
export function drainEventStreamMessages(buffer: Uint8Array): { readonly messages: readonly DecodedEventStreamMessage[]; readonly rest: Uint8Array } {
  const messages: DecodedEventStreamMessage[] = [];
  let offset = 0;
  while (buffer.length - offset >= 12) {
    const view = new DataView(buffer.buffer, buffer.byteOffset + offset, buffer.length - offset);
    const totalLength = view.getUint32(0, false);
    if (totalLength < 16 || totalLength > 16 * 1024 * 1024) throw new BedrockEventStreamError(`invalid eventstream frame total_length: ${totalLength}`);
    if (buffer.length - offset < totalLength) break; // partial frame; wait for more bytes
    const headersLength = view.getUint32(4, false);
    const preludeCrc = view.getUint32(8, false);
    const prelude = buffer.subarray(offset, offset + 8);
    if (crc32(prelude) !== preludeCrc) throw new BedrockEventStreamError("eventstream prelude CRC mismatch");
    const frame = buffer.subarray(offset, offset + totalLength);
    const expectedMessageCrc = new DataView(frame.buffer, frame.byteOffset + totalLength - 4, 4).getUint32(0, false);
    const withoutTrailingCrc = frame.subarray(0, totalLength - 4);
    if (crc32(withoutTrailingCrc) !== expectedMessageCrc) throw new BedrockEventStreamError("eventstream message CRC mismatch");
    const headersStart = 12;
    const headersEnd = headersStart + headersLength;
    const payloadEnd = totalLength - 4;
    if (headersEnd > payloadEnd) throw new BedrockEventStreamError("eventstream headers_length exceeds frame bounds");
    const headers = decodeHeaders(frame.subarray(headersStart, headersEnd));
    const payload = frame.subarray(headersEnd, payloadEnd);
    messages.push(Object.freeze({ headers, payload: Uint8Array.from(payload) }));
    offset += totalLength;
  }
  return Object.freeze({ messages, rest: buffer.subarray(offset) });
}

function decodeHeaders(bytes: Uint8Array): ReadonlyMap<string, string> {
  const headers = new Map<string, string>();
  let offset = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (offset < bytes.length) {
    const nameLen = view.getUint8(offset);
    offset += 1;
    const name = new TextDecoder().decode(bytes.subarray(offset, offset + nameLen));
    offset += nameLen;
    const valueType = view.getUint8(offset);
    offset += 1;
    if (valueType !== HEADER_VALUE_TYPE_STRING) {
      // Bedrock's own headers are always the string type; skip anything
      // else conservatively using its declared length prefix rather than
      // failing the whole message on a header this module does not need.
      offset = skipNonStringHeaderValue(view, offset, valueType);
      continue;
    }
    const valueLen = view.getUint16(offset, false);
    offset += 2;
    const value = new TextDecoder().decode(bytes.subarray(offset, offset + valueLen));
    offset += valueLen;
    headers.set(name, value);
  }
  return headers;
}

/** Skips a header value this module does not interpret, per the eventstream spec's per-type length encoding. */
function skipNonStringHeaderValue(view: DataView, offset: number, valueType: number): number {
  switch (valueType) {
    case 0: // true (no value bytes)
    case 1: // false
      return offset;
    case 2: // byte
      return offset + 1;
    case 3: // short
      return offset + 2;
    case 4: // integer
      return offset + 4;
    case 5: // long
      return offset + 8;
    case 6: // byte array (u16-length prefixed)
    case 8: // timestamp is an 8-byte long in this format's encoding
      return valueType === 8 ? offset + 8 : offset + 2 + view.getUint16(offset, false);
    case 9: { // uuid: 16 raw bytes
      return offset + 16;
    }
    default:
      throw new BedrockEventStreamError(`unsupported eventstream header value type: ${valueType}`);
  }
}

/** CRC32 (ISO-HDLC / zlib polynomial), reproduced directly per the eventstream spec -- no dependency on `node:zlib`'s newer `crc32` API. */
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

/**
 * No encoder lives here: production code (`bedrock-messages.ts`) only ever
 * decodes this framing -- real Bedrock responses arrive already framed by
 * AWS's own servers. A test-only encoder (needed to build CRC-valid fixture
 * frames for `bedrock-eventstream.test.ts`/`bedrock-messages.test.ts`) lives
 * in `tests/helpers/bedrock-eventstream-fixture.ts` instead, so this
 * module's only export with no production caller isn't a dead export
 * `gate:reachability` has to flag.
 */
