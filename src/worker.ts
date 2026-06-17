import { LibterminalError } from "./index.js";

export const WEB_SOCKET_CONNECTING = 0;
export const WEB_SOCKET_OPEN = 1;

export type WebSocketPayload = string | ArrayBuffer;

export type WebSocketMessageEventLike = {
  data: unknown;
};

export type WebSocketCloseEventLike = {
  code?: number;
  reason?: string;
};

export type WebSocketLike = {
  readonly readyState: number;
  send(data: WebSocketPayload): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", listener: (event: WebSocketMessageEventLike) => void): void;
  addEventListener(type: "close", listener: (event: WebSocketCloseEventLike) => void): void;
  addEventListener(type: "error", listener: () => void): void;
  removeEventListener(type: "message", listener: (event: WebSocketMessageEventLike) => void): void;
  removeEventListener(type: "close", listener: (event: WebSocketCloseEventLike) => void): void;
  removeEventListener(type: "error", listener: () => void): void;
};

export type WebSocketBridgeOptions = {
  canSendLeft?: () => Promise<boolean>;
  reconcileSubscription?: () => void;
  deniedReason?: string;
  controlCheckIntervalMs?: number;
  forwardRightOutputAcknowledgements?: boolean;
  acknowledgeRightOutputImmediately?: boolean;
  sanitizeCloseReason?: (reason: string) => string;
  onError?: (error: unknown) => void;
};

export type WebSocketBridge = {
  readonly completed: Promise<void>;
  readonly rightOutputAcknowledgementBytes: number;
  revalidateControl(): Promise<boolean>;
  close(code?: number, reason?: string): void;
};

const encoder = new TextEncoder();

export function bridgeWebSockets(
  left: WebSocketLike,
  right: WebSocketLike,
  options: WebSocketBridgeOptions = {},
): WebSocketBridge {
  const deniedReason = options.deniedReason ?? "terminal control revoked";
  const controlCheckIntervalMs = options.controlCheckIntervalMs ?? 5000;
  let leftInputQueue = Promise.resolve();
  let rightOutputQueue = Promise.resolve();
  let controlTimer: ReturnType<typeof setInterval> | undefined;
  let controlCheckInFlight: Promise<boolean> | undefined;
  let leftCanSend = true;
  let outstandingRightBytes = 0;
  let stopped = false;
  let resolveCompleted = noop;
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve;
  });
  const reportError = (error: unknown) => {
    try {
      options.onError?.(error);
    } catch {
      // Error reporting must not interrupt bridge teardown.
    }
  };
  const sanitizeReason = (value: unknown) => {
    const source = typeof value === "string" ? value : "";
    try {
      return cleanReason(options.sanitizeCloseReason?.(source) ?? source);
    } catch (error) {
      reportError(error);
      return "";
    }
  };

  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    if (controlTimer) {
      clearInterval(controlTimer);
      controlTimer = undefined;
    }
    left.removeEventListener("message", onLeftMessage);
    right.removeEventListener("message", onRightMessage);
    left.removeEventListener("close", onLeftClose);
    right.removeEventListener("close", onRightClose);
    left.removeEventListener("error", onLeftError);
    right.removeEventListener("error", onRightError);
    void Promise.allSettled([leftInputQueue, rightOutputQueue]).then(() => resolveCompleted());
  };

  const close = (code = 1000, reason = "bridge closed") => {
    closePair(left, right, code, sanitizeReason(reason));
    stop();
  };

  const fail = (error: unknown) => {
    reportError(error);
    close(1011, "terminal bridge error");
  };

  const verifyControl = async (): Promise<boolean> => {
    if (!options.canSendLeft) {
      return true;
    }
    let canSend = false;
    try {
      canSend = await options.canSendLeft();
    } catch (error) {
      reportError(error);
    }
    leftCanSend = canSend;
    if (!canSend) {
      close(1008, deniedReason);
    }
    return canSend;
  };

  const revalidateControl = async (): Promise<boolean> => {
    if (stopped) {
      return false;
    }
    try {
      options.reconcileSubscription?.();
      controlCheckInFlight ??= verifyControl().finally(() => {
        controlCheckInFlight = undefined;
      });
      return await controlCheckInFlight;
    } catch (error) {
      fail(error);
      return false;
    }
  };

  function onLeftMessage(event: WebSocketMessageEventLike): void {
    leftInputQueue = leftInputQueue
      .then(async () => {
        if (!pairIsOpen(left, right)) {
          return;
        }
        if (!leftCanSend || !(await revalidateControl())) {
          return;
        }
        const forwarded = await normalizeWebSocketMessageData(event.data);
        const acknowledgedBytes = options.forwardRightOutputAcknowledgements
          ? decodeOutputAcknowledgement(forwarded)
          : null;
        if (acknowledgedBytes !== null) {
          if (acknowledgedBytes <= outstandingRightBytes) {
            outstandingRightBytes -= acknowledgedBytes;
            sendOutputAcknowledgement(right, acknowledgedBytes);
          }
          return;
        }
        right.send(forwarded);
      })
      .catch(fail);
  }

  function onRightMessage(event: WebSocketMessageEventLike): void {
    rightOutputQueue = rightOutputQueue
      .then(async () => {
        if (!pairIsOpen(left, right)) {
          return;
        }
        const forwarded = await normalizeWebSocketMessageData(event.data);
        left.send(forwarded);
        if (options.forwardRightOutputAcknowledgements) {
          outstandingRightBytes += terminalMessageByteLength(forwarded);
        } else if (options.acknowledgeRightOutputImmediately) {
          sendOutputAcknowledgement(right, terminalMessageByteLength(forwarded));
        }
      })
      .catch(fail);
  }

  function onLeftClose(event: WebSocketCloseEventLike): void {
    closePeer(event, right, sanitizeReason);
    stop();
  }

  function onRightClose(event: WebSocketCloseEventLike): void {
    closePeer(event, left, sanitizeReason);
    stop();
  }

  function onLeftError(): void {
    fail(new LibterminalError("transport_closed", "left WebSocket failed"));
  }

  function onRightError(): void {
    fail(new LibterminalError("transport_closed", "right WebSocket failed"));
  }

  left.addEventListener("message", onLeftMessage);
  right.addEventListener("message", onRightMessage);
  left.addEventListener("close", onLeftClose);
  right.addEventListener("close", onRightClose);
  left.addEventListener("error", onLeftError);
  right.addEventListener("error", onRightError);

  if (options.canSendLeft) {
    void revalidateControl();
    if (controlCheckIntervalMs > 0) {
      controlTimer = setInterval(() => void revalidateControl(), controlCheckIntervalMs);
    }
  }

  return {
    completed,
    get rightOutputAcknowledgementBytes() {
      return outstandingRightBytes;
    },
    revalidateControl,
    close,
  };
}

export function terminalOutputAcknowledgements(value: string): boolean {
  try {
    return new URL(value).searchParams.get("flow") === "ack-v1";
  } catch {
    return false;
  }
}

export function decodeOutputAcknowledgement(value: WebSocketPayload): number | null {
  if (typeof value !== "string" || !value.startsWith("{") || value.length > 100) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) {
      return null;
    }
    const bytes = parsed.bytes;
    return parsed.type === "ack" &&
      Number.isInteger(bytes) &&
      Number(bytes) > 0 &&
      Number(bytes) <= 1024 * 1024
      ? Number(bytes)
      : null;
  } catch {
    return null;
  }
}

export function terminalMessageByteLength(value: WebSocketPayload): number {
  return typeof value === "string" ? encoder.encode(value).byteLength : value.byteLength;
}

export function sendOutputAcknowledgement(socket: WebSocketLike, bytes: number): void {
  if (bytes > 0 && socket.readyState === WEB_SOCKET_OPEN) {
    socket.send(JSON.stringify({ type: "ack", bytes }));
  }
}

export async function normalizeWebSocketMessageData(data: unknown): Promise<WebSocketPayload> {
  if (typeof data === "string" || data instanceof ArrayBuffer) {
    return data;
  }
  if (ArrayBuffer.isView(data)) {
    const copied = new Uint8Array(data.byteLength);
    copied.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    return copied.buffer;
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return data.arrayBuffer();
  }
  if (hasArrayBuffer(data)) {
    return data.arrayBuffer();
  }
  return String(data);
}

function pairIsOpen(left: WebSocketLike, right: WebSocketLike): boolean {
  return left.readyState === WEB_SOCKET_OPEN && right.readyState === WEB_SOCKET_OPEN;
}

function closePeer(
  event: WebSocketCloseEventLike,
  peer: WebSocketLike,
  sanitizeReason: (value: unknown) => string,
): void {
  if (canClose(peer)) {
    safeClose(peer, event.code || 1000, sanitizeReason(event.reason || "peer closed"));
  }
}

function closePair(left: WebSocketLike, right: WebSocketLike, code: number, reason: string): void {
  if (canClose(left)) {
    safeClose(left, code, reason);
  }
  if (canClose(right)) {
    safeClose(right, code, reason);
  }
}

function canClose(socket: WebSocketLike): boolean {
  return socket.readyState === WEB_SOCKET_OPEN || socket.readyState === WEB_SOCKET_CONNECTING;
}

function cleanReason(value: unknown): string {
  const source = (typeof value === "string" ? value : "").trim();
  let result = "";
  let bytes = 0;
  for (const character of source) {
    const characterBytes = encoder.encode(character).byteLength;
    if (bytes + characterBytes > 123) {
      break;
    }
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function safeClose(socket: WebSocketLike, code: number, reason: string): void {
  const safeCode = validCloseCode(code) ? code : 1000;
  const safeReason = cleanReason(reason);
  try {
    socket.close(safeCode, safeReason);
  } catch {
    try {
      socket.close(1000, safeReason);
    } catch {
      try {
        socket.close();
      } catch {
        // Closing is best-effort after a peer has already failed.
      }
    }
  }
}

function validCloseCode(code: number): boolean {
  return (
    code === 1000 ||
    (code >= 1001 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) ||
    (code >= 3000 && code <= 4999)
  );
}

function hasArrayBuffer(value: unknown): value is { arrayBuffer(): Promise<ArrayBuffer> } {
  return (
    value !== null &&
    typeof value === "object" &&
    "arrayBuffer" in value &&
    typeof value.arrayBuffer === "function"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function noop(): void {}
