import { describe, expect, it, vi } from "vitest";
import {
  bridgeWebSockets,
  decodeOutputAcknowledgement,
  normalizeWebSocketMessageData,
  WEB_SOCKET_OPEN,
  type WebSocketCloseEventLike,
  type WebSocketLike,
  type WebSocketMessageEventLike,
  type WebSocketPayload,
} from "../src/worker.js";

function acceptsNativeWebSocket(socket: WebSocket): void {
  bridgeWebSockets(socket, socket);
}
void acceptsNativeWebSocket;

describe("bridgeWebSockets", () => {
  it("forwards duplex messages in order", async () => {
    const left = new FakeWebSocket();
    const right = new FakeWebSocket();
    const bridge = bridgeWebSockets(left, right, { controlCheckIntervalMs: 0 });
    left.emitMessage("one");
    left.emitMessage("two");
    right.emitMessage("three");
    await vi.waitFor(() => {
      expect(right.sent).toEqual(["one", "two"]);
      expect(left.sent).toEqual(["three"]);
    });
    bridge.close();
    await bridge.completed;
  });

  it("fails closed when terminal control is revoked", async () => {
    const left = new FakeWebSocket();
    const right = new FakeWebSocket();
    const bridge = bridgeWebSockets(left, right, {
      canSendLeft: async () => false,
      controlCheckIntervalMs: 0,
    });
    await expect(bridge.revalidateControl()).resolves.toBe(false);
    expect(left.closed).toEqual({ code: 1008, reason: "terminal control revoked" });
    expect(right.closed).toEqual({ code: 1008, reason: "terminal control revoked" });
  });

  it("fails closed when control reconciliation throws", async () => {
    const left = new FakeWebSocket();
    const right = new FakeWebSocket();
    const errors: unknown[] = [];
    const bridge = bridgeWebSockets(left, right, {
      canSendLeft: async () => true,
      reconcileSubscription: () => {
        throw new Error("lookup failed");
      },
      controlCheckIntervalMs: 0,
      onError: (error) => errors.push(error),
    });
    await expect(bridge.revalidateControl()).resolves.toBe(false);
    expect(errors).toHaveLength(1);
    expect(left.closed).toEqual({ code: 1011, reason: "terminal bridge error" });
    expect(right.closed).toEqual({ code: 1011, reason: "terminal bridge error" });
  });

  it("tracks and forwards right-output acknowledgements", async () => {
    const left = new FakeWebSocket();
    const right = new FakeWebSocket();
    const bridge = bridgeWebSockets(left, right, {
      controlCheckIntervalMs: 0,
      forwardRightOutputAcknowledgements: true,
    });
    right.emitMessage("hello");
    await vi.waitFor(() => expect(bridge.rightOutputAcknowledgementBytes).toBe(5));
    left.emitMessage('{"type":"ack","bytes":5}');
    await vi.waitFor(() => expect(right.sent).toEqual(['{"type":"ack","bytes":5}']));
    expect(bridge.rightOutputAcknowledgementBytes).toBe(0);
  });

  it("sanitizes abnormal peer close metadata", () => {
    const left = new FakeWebSocket();
    const right = new FakeWebSocket();
    bridgeWebSockets(left, right, { controlCheckIntervalMs: 0 });
    left.emitClose(1006, "é".repeat(100));
    expect(right.closed?.code).toBe(1000);
    expect(new TextEncoder().encode(right.closed?.reason).byteLength).toBeLessThanOrEqual(123);
  });
});

describe("Worker message helpers", () => {
  it("normalizes views without leaking unrelated backing-buffer bytes", async () => {
    const backing = Uint8Array.from([1, 2, 3, 4]);
    const normalized = await normalizeWebSocketMessageData(backing.subarray(1, 3));
    expect([...new Uint8Array(normalized as ArrayBuffer)]).toEqual([2, 3]);
  });

  it("strictly parses bounded acknowledgement messages", () => {
    expect(decodeOutputAcknowledgement('{"type":"ack","bytes":42}')).toBe(42);
    expect(decodeOutputAcknowledgement('{"type":"ack","bytes":0}')).toBeNull();
    expect(decodeOutputAcknowledgement("not json")).toBeNull();
  });
});

class FakeWebSocket implements WebSocketLike {
  readyState = WEB_SOCKET_OPEN;
  readonly sent: WebSocketPayload[] = [];
  closed?: { code?: number; reason?: string };
  private readonly messages = new Set<(event: WebSocketMessageEventLike) => void>();
  private readonly closes = new Set<(event: WebSocketCloseEventLike) => void>();
  private readonly errors = new Set<() => void>();

  send(data: WebSocketPayload): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.readyState = 3;
  }

  addEventListener(
    type: "message" | "close" | "error",
    listener:
      | ((event: WebSocketMessageEventLike) => void)
      | ((event: WebSocketCloseEventLike) => void)
      | (() => void),
  ): void {
    if (type === "message") {
      this.messages.add(listener as (event: WebSocketMessageEventLike) => void);
    } else if (type === "close") {
      this.closes.add(listener as (event: WebSocketCloseEventLike) => void);
    } else {
      this.errors.add(listener as () => void);
    }
  }

  removeEventListener(
    type: "message" | "close" | "error",
    listener:
      | ((event: WebSocketMessageEventLike) => void)
      | ((event: WebSocketCloseEventLike) => void)
      | (() => void),
  ): void {
    if (type === "message") {
      this.messages.delete(listener as (event: WebSocketMessageEventLike) => void);
    } else if (type === "close") {
      this.closes.delete(listener as (event: WebSocketCloseEventLike) => void);
    } else {
      this.errors.delete(listener as () => void);
    }
  }

  emitMessage(data: unknown): void {
    for (const listener of this.messages) {
      listener({ data });
    }
  }

  emitClose(code: number, reason: string): void {
    this.readyState = 3;
    for (const listener of this.closes) {
      listener({ code, reason });
    }
  }
}
