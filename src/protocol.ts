import { assertTerminalSize, LibterminalError, type TerminalSize } from "./index.js";

export const TERMINAL_WS_MAGIC = 0x5943;
export const TERMINAL_WS_VERSION = 2;
export const DEFAULT_MAX_TERMINAL_FRAME_BYTES = 1024 * 1024;
export const DEFAULT_MAX_SESSION_ID_BYTES = 4096;

export const TerminalMessageType = {
  Hello: 1,
  Welcome: 2,
  Subscribe: 10,
  Unsubscribe: 11,
  Output: 20,
  Snapshot: 21,
  Event: 22,
  Error: 23,
  Input: 30,
  Key: 31,
  Resize: 32,
  Stop: 33,
  ControlRequest: 50,
  ControlDecision: 51,
  ControlGranted: 52,
  ControlRevoked: 53,
  Ping: 60,
  Pong: 61,
  Ack: 62,
} as const;

export type TerminalMessageType = (typeof TerminalMessageType)[keyof typeof TerminalMessageType];

export const TerminalSubscribeFlags = {
  Output: 1 << 0,
  Snapshot: 1 << 1,
  Events: 1 << 2,
  OutputAcknowledgements: 1 << 3,
} as const;

export type TerminalFrame = {
  type: TerminalMessageType;
  sessionId: string;
  payload: Uint8Array;
};

export type TerminalFrameLimits = {
  maxFrameBytes?: number;
  maxSessionIdBytes?: number;
};

export type TerminalSubscribe = {
  flags: number;
  snapshotMinIntervalMs: number;
  snapshotMaxIntervalMs: number;
  columns: number;
  rows: number;
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const terminalMessageTypes = new Set<number>(Object.values(TerminalMessageType));

export function encodeTerminalFrame(
  params: {
    type: TerminalMessageType;
    sessionId?: string;
    payload?: Uint8Array;
  },
  limits?: TerminalFrameLimits,
): Uint8Array {
  const sessionId = params.sessionId ?? "";
  const sessionIdBytes = textEncoder.encode(sessionId);
  const payload = params.payload ?? new Uint8Array();
  const maxSessionIdBytes = limits?.maxSessionIdBytes ?? DEFAULT_MAX_SESSION_ID_BYTES;
  const maxFrameBytes = limits?.maxFrameBytes ?? DEFAULT_MAX_TERMINAL_FRAME_BYTES;

  if (sessionIdBytes.byteLength > maxSessionIdBytes) {
    throw invalidFrame(`session id exceeds ${maxSessionIdBytes} bytes`);
  }
  if (!isTerminalMessageType(params.type)) {
    throw invalidFrame(`terminal frame message type ${String(params.type)} is unsupported`);
  }

  const headerLength = 2 + 1 + 1 + 4 + sessionIdBytes.length + 4;
  const frameLength = headerLength + payload.length;
  if (frameLength > maxFrameBytes) {
    throw invalidFrame(`terminal frame exceeds ${maxFrameBytes} bytes`);
  }

  const frame = new Uint8Array(frameLength);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  let offset = 0;
  view.setUint16(offset, TERMINAL_WS_MAGIC, true);
  offset += 2;
  view.setUint8(offset, TERMINAL_WS_VERSION);
  offset += 1;
  view.setUint8(offset, params.type);
  offset += 1;
  view.setUint32(offset, sessionIdBytes.length, true);
  offset += 4;
  frame.set(sessionIdBytes, offset);
  offset += sessionIdBytes.length;
  view.setUint32(offset, payload.length, true);
  offset += 4;
  frame.set(payload, offset);
  return frame;
}

export function decodeTerminalFrame(data: Uint8Array, limits?: TerminalFrameLimits): TerminalFrame {
  const maxFrameBytes = limits?.maxFrameBytes ?? DEFAULT_MAX_TERMINAL_FRAME_BYTES;
  const maxSessionIdBytes = limits?.maxSessionIdBytes ?? DEFAULT_MAX_SESSION_ID_BYTES;
  if (data.byteLength > maxFrameBytes) {
    throw invalidFrame(`terminal frame exceeds ${maxFrameBytes} bytes`);
  }
  if (data.byteLength < 12) {
    throw invalidFrame("terminal frame is shorter than its fixed header");
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;
  if (view.getUint16(offset, true) !== TERMINAL_WS_MAGIC) {
    throw invalidFrame("terminal frame has invalid magic");
  }
  offset += 2;
  const version = view.getUint8(offset);
  if (version !== TERMINAL_WS_VERSION) {
    throw new LibterminalError(
      "unsupported_protocol",
      `terminal protocol version ${version} is unsupported`,
    );
  }
  offset += 1;
  const type = view.getUint8(offset);
  if (!isTerminalMessageType(type)) {
    throw invalidFrame(`terminal frame message type ${type} is unsupported`);
  }
  offset += 1;
  const sessionIdLength = view.getUint32(offset, true);
  offset += 4;
  if (sessionIdLength > maxSessionIdBytes) {
    throw invalidFrame(`session id exceeds ${maxSessionIdBytes} bytes`);
  }
  if (offset + sessionIdLength + 4 > data.byteLength) {
    throw invalidFrame("terminal frame session id length exceeds frame length");
  }

  let sessionId: string;
  try {
    sessionId = textDecoder.decode(data.subarray(offset, offset + sessionIdLength));
  } catch (cause) {
    throw new LibterminalError("invalid_frame", "terminal frame session id is not UTF-8", {
      cause,
    });
  }
  offset += sessionIdLength;
  const payloadLength = view.getUint32(offset, true);
  offset += 4;
  if (offset + payloadLength !== data.byteLength) {
    throw invalidFrame("terminal frame payload length does not match frame length");
  }
  return {
    type,
    sessionId,
    payload: data.subarray(offset, offset + payloadLength),
  };
}

export function tryDecodeTerminalFrame(
  data: Uint8Array,
  limits?: TerminalFrameLimits,
): TerminalFrame | null {
  try {
    return decodeTerminalFrame(data, limits);
  } catch {
    return null;
  }
}

export function encodeSubscribePayload(params: {
  flags: number;
  snapshotMinIntervalMs?: number;
  snapshotMaxIntervalMs?: number;
  columns: number;
  rows: number;
}): Uint8Array {
  assertSubscribeSize({ columns: params.columns, rows: params.rows });
  const payload = new Uint8Array(20);
  const view = new DataView(payload.buffer);
  view.setUint32(0, params.flags >>> 0, true);
  view.setUint32(4, (params.snapshotMinIntervalMs ?? 0) >>> 0, true);
  view.setUint32(8, (params.snapshotMaxIntervalMs ?? 0) >>> 0, true);
  view.setUint32(12, params.columns >>> 0, true);
  view.setUint32(16, params.rows >>> 0, true);
  return payload;
}

export function decodeSubscribePayload(payload: Uint8Array): TerminalSubscribe {
  if (payload.byteLength !== 20) {
    throw invalidFrame("terminal subscribe payload must be exactly 20 bytes");
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const decoded = {
    flags: view.getUint32(0, true),
    snapshotMinIntervalMs: view.getUint32(4, true),
    snapshotMaxIntervalMs: view.getUint32(8, true),
    columns: view.getUint32(12, true),
    rows: view.getUint32(16, true),
  };
  assertSubscribeSize(decoded);
  return decoded;
}

export function encodeResizePayload(size: TerminalSize): Uint8Array {
  assertTerminalSize(size);
  const payload = new Uint8Array(8);
  const view = new DataView(payload.buffer);
  view.setUint32(0, size.columns >>> 0, true);
  view.setUint32(4, size.rows >>> 0, true);
  return payload;
}

export function decodeResizePayload(payload: Uint8Array): TerminalSize {
  if (payload.byteLength !== 8) {
    throw invalidFrame("terminal resize payload must be exactly 8 bytes");
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return assertTerminalSize({
    columns: view.getUint32(0, true),
    rows: view.getUint32(4, true),
  });
}

export function encodeAckPayload(bytes: number): Uint8Array {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 0xffff_ffff) {
    throw invalidFrame("terminal acknowledgement must be an unsigned 32-bit integer");
  }
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setUint32(0, bytes, true);
  return payload;
}

export function decodeAckPayload(payload: Uint8Array): number {
  if (payload.byteLength !== 4) {
    throw invalidFrame("terminal acknowledgement payload must be exactly 4 bytes");
  }
  return new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0, true);
}

export function encodeJsonPayload(value: unknown): Uint8Array {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch (cause) {
    throw new LibterminalError("invalid_frame", "terminal JSON payload is not serializable", {
      cause,
    });
  }
  if (json === undefined) {
    throw invalidFrame("terminal JSON payload is not serializable");
  }
  return textEncoder.encode(json);
}

export function decodeJsonPayload(payload: Uint8Array): unknown {
  try {
    const value: unknown = JSON.parse(textDecoder.decode(payload));
    return value;
  } catch (cause) {
    throw new LibterminalError("invalid_frame", "terminal JSON payload is invalid", { cause });
  }
}

function invalidFrame(message: string): LibterminalError {
  return new LibterminalError("invalid_frame", message);
}

function assertSubscribeSize(size: TerminalSize): TerminalSize {
  if (size.columns === 0 && size.rows === 0) {
    return size;
  }
  return assertTerminalSize(size);
}

function isTerminalMessageType(value: number): value is TerminalMessageType {
  return terminalMessageTypes.has(value);
}
