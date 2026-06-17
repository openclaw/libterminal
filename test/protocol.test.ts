import { describe, expect, it } from "vitest";
import { LibterminalError } from "../src/index.js";
import {
  decodeAckPayload,
  decodeResizePayload,
  decodeSubscribePayload,
  decodeTerminalFrame,
  encodeAckPayload,
  encodeResizePayload,
  encodeSubscribePayload,
  encodeTerminalFrame,
  TerminalMessageType,
  tryDecodeTerminalFrame,
} from "../src/protocol.js";

const vectors = {
  outputFrame: "435902140600000049532d31323304000000000102ff",
  pingFrame: "4359023c0000000000000000",
  subscribe: "0d00000000000000000000009000000029000000",
  resize: "840000002b000000",
  ack: "ffff0000",
};

describe("terminal protocol v2", () => {
  it("matches the canonical output and ping frame vectors", () => {
    expect(
      hex(
        encodeTerminalFrame({
          type: TerminalMessageType.Output,
          sessionId: "IS-123",
          payload: Uint8Array.from([0, 1, 2, 255]),
        }),
      ),
    ).toBe(vectors.outputFrame);
    expect(hex(encodeTerminalFrame({ type: TerminalMessageType.Ping }))).toBe(vectors.pingFrame);
  });

  it("matches the canonical control payload vectors", () => {
    expect(
      hex(
        encodeSubscribePayload({
          flags: 13,
          columns: 144,
          rows: 41,
        }),
      ),
    ).toBe(vectors.subscribe);
    expect(hex(encodeResizePayload({ columns: 132, rows: 43 }))).toBe(vectors.resize);
    expect(hex(encodeAckPayload(65_535))).toBe(vectors.ack);
  });

  it("round-trips frames and payloads", () => {
    const frame = decodeTerminalFrame(fromHex(vectors.outputFrame));
    expect(frame.type).toBe(TerminalMessageType.Output);
    expect(frame.sessionId).toBe("IS-123");
    expect([...frame.payload]).toEqual([0, 1, 2, 255]);
    expect(decodeSubscribePayload(fromHex(vectors.subscribe))).toEqual({
      flags: 13,
      snapshotMinIntervalMs: 0,
      snapshotMaxIntervalMs: 0,
      columns: 144,
      rows: 41,
    });
    expect(decodeResizePayload(fromHex(vectors.resize))).toEqual({ columns: 132, rows: 43 });
    expect(decodeAckPayload(fromHex(vectors.ack))).toBe(65_535);
  });

  it("rejects unsupported versions and malformed lengths", () => {
    const unsupported = fromHex(vectors.pingFrame);
    unsupported[2] = 99;
    expect(() => decodeTerminalFrame(unsupported)).toThrowError(
      expect.objectContaining<Partial<LibterminalError>>({ code: "unsupported_protocol" }),
    );

    const malformed = fromHex(vectors.outputFrame);
    malformed[8] = 255;
    expect(() => decodeTerminalFrame(malformed)).toThrowError(
      expect.objectContaining<Partial<LibterminalError>>({ code: "invalid_frame" }),
    );
    expect(tryDecodeTerminalFrame(malformed)).toBeNull();
  });
});

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function fromHex(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "hex"));
}
