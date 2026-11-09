import { describe, expect, it } from "vitest";

import { drainEventStreamMessages, BedrockEventStreamError } from "../src/bedrock-eventstream.js";
import { encodeEventStreamMessage } from "./helpers/bedrock-eventstream-fixture.js";

/**
 * The reference frame below was cross-computed independently in Python
 * (`struct` + `binascii.crc32`, the same ISO-HDLC/zlib CRC32 AWS's
 * eventstream format specifies) rather than by running this module, so the
 * test does not just check the encoder against itself.
 */
const REFERENCE_FRAME_HEX =
  "000000730000004b3a5edd6e0d3a6d6573736167652d747970650700056576656e740b3a6576656e742d747970650700056368756e6b0d3a636f6e74656e742d747970650700106170706c69636174696f6e2f6a736f6e7b226279746573223a2265794a6f615349364d58303d227d3e1e2813";

function headerMap(entries: readonly (readonly [string, string])[]): Map<string, string> {
  return new Map(entries);
}

describe("bedrock eventstream framing", () => {
  it("decodes a reference frame computed independently in Python", () => {
    const bytes = Uint8Array.from(Buffer.from(REFERENCE_FRAME_HEX, "hex"));
    const { messages, rest } = drainEventStreamMessages(bytes);
    expect(rest.length).toBe(0);
    expect(messages).toHaveLength(1);
    const message = messages[0]!;
    expect(message.headers.get(":message-type")).toBe("event");
    expect(message.headers.get(":event-type")).toBe("chunk");
    expect(message.headers.get(":content-type")).toBe("application/json");
    expect(new TextDecoder().decode(message.payload)).toBe('{"bytes":"eyJoaSI6MX0="}');
  });

  it("round-trips encode -> decode for an arbitrary message", () => {
    const headers = headerMap([[":message-type", "event"], [":event-type", "chunk"], [":content-type", "application/json"]]);
    const inner = { bytes: Buffer.from(JSON.stringify({ type: "message_start" })).toString("base64") };
    const payload = new TextEncoder().encode(JSON.stringify(inner));
    const frame = encodeEventStreamMessage(headers, payload);
    const { messages } = drainEventStreamMessages(frame);
    expect(messages).toHaveLength(1);
    expect(JSON.parse(new TextDecoder().decode(messages[0]!.payload))).toEqual(inner);
  });

  it("matches the Python-computed reference frame byte-for-byte when encoding the same content", () => {
    const headers = headerMap([[":message-type", "event"], [":event-type", "chunk"], [":content-type", "application/json"]]);
    const payload = new TextEncoder().encode('{"bytes":"eyJoaSI6MX0="}');
    const frame = encodeEventStreamMessage(headers, payload);
    expect(Buffer.from(frame).toString("hex")).toBe(REFERENCE_FRAME_HEX);
  });

  it("buffers a partial frame across chunk boundaries", () => {
    const bytes = Uint8Array.from(Buffer.from(REFERENCE_FRAME_HEX, "hex"));
    const first = bytes.subarray(0, 20);
    const { messages: firstMessages, rest } = drainEventStreamMessages(first);
    expect(firstMessages).toHaveLength(0);
    expect(rest.length).toBe(20);
    const combined = new Uint8Array(rest.length + (bytes.length - 20));
    combined.set(rest, 0);
    combined.set(bytes.subarray(20), rest.length);
    const { messages: secondMessages, rest: secondRest } = drainEventStreamMessages(combined);
    expect(secondMessages).toHaveLength(1);
    expect(secondRest.length).toBe(0);
  });

  it("rejects a frame with a corrupted message CRC", () => {
    const bytes = Uint8Array.from(Buffer.from(REFERENCE_FRAME_HEX, "hex"));
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
    expect(() => drainEventStreamMessages(bytes)).toThrow(BedrockEventStreamError);
  });

  it("rejects a frame with a corrupted prelude CRC", () => {
    const bytes = Uint8Array.from(Buffer.from(REFERENCE_FRAME_HEX, "hex"));
    bytes[10] = bytes[10]! ^ 0xff;
    expect(() => drainEventStreamMessages(bytes)).toThrow(BedrockEventStreamError);
  });

  it("decodes an exception message shape (throttlingException)", () => {
    const headers = headerMap([[":message-type", "exception"], [":exception-type", "throttlingException"], [":content-type", "application/json"]]);
    const payload = new TextEncoder().encode(JSON.stringify({ message: "Too many requests" }));
    const frame = encodeEventStreamMessage(headers, payload);
    const { messages } = drainEventStreamMessages(frame);
    expect(messages[0]!.headers.get(":message-type")).toBe("exception");
    expect(messages[0]!.headers.get(":exception-type")).toBe("throttlingException");
  });
});
