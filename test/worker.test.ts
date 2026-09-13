import { describe, expect, it, vi } from "vitest";
import { FakeWebSocket } from "../src/testing.js";
import {
  bridgeWebSockets,
  decodeOutputAcknowledgement,
  normalizeWebSocketMessageData,
} from "../src/worker.js";

function acceptsNativeWebSocket(socket: WebSocket): void {
  bridgeWebSockets(socket, socket);
}
void acceptsNativeWebSocket;

function redactTestToken(reason: string): string {
  return reason.replace(/token=[^ ]+/g, "token=[redacted]");
}

describe("bridgeWebSockets", () => {
  it.each(["left", "right"])("discards %s payloads normalized after close", async (direction) => {
    const left = new FakeWebSocket();
    const right = new FakeWebSocket();
    const bridge = bridgeWebSockets(left, right, { controlCheckIntervalMs: 0 });
    let markStarted!: () => void;
    let resolvePayload!: (value: ArrayBuffer) => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const payload = new Promise<ArrayBuffer>((resolve) => {
      resolvePayload = resolve;
    });
    const source = direction === "left" ? left : right;
    const target = direction === "left" ? right : left;
    source.receive({
      arrayBuffer: () => {
        markStarted();
        return payload;
      },
    });
    await started;
    bridge.close();
    resolvePayload(new Uint8Array([42]).buffer);
    await bridge.completed;
    expect(target.sent).toEqual([]);
    expect(bridge.rightOutputAcknowledgementBytes).toBe(0);
  });

  it("stays stopped after a pending control check even when socket close fails", async () => {
    const left = new FakeWebSocket();
    const right = new FakeWebSocket();
    for (const socket of [left, right]) {
      vi.spyOn(socket, "close").mockImplementation(() => {
        throw new Error("close failed");
      });
    }
    let allow!: (value: boolean) => void;
    const control = new Promise<boolean>((resolve) => {
      allow = resolve;
    });
    const bridge = bridgeWebSockets(left, right, {
      canSendLeft: () => control,
      controlCheckIntervalMs: 0,
    });
    const checked = bridge.revalidateControl();
    left.receive("input");
    await Promise.resolve();
    bridge.close();
    allow(true);

    await bridge.completed;
    await expect(checked).resolves.toBe(false);
    expect(right.sent).toEqual([]);
  });

  it("does not start a control timer after setup has already failed", async () => {
    vi.useFakeTimers();
    try {
      const bridge = bridgeWebSockets(new FakeWebSocket(), new FakeWebSocket(), {
        canSendLeft: async () => true,
        reconcileSubscription: () => {
          throw new Error("setup failed");
        },
      });
      await bridge.completed;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("forwards duplex messages in order", async () => {
    const left = new FakeWebSocket();
    const right = new FakeWebSocket();
    const bridge = bridgeWebSockets(left, right, { controlCheckIntervalMs: 0 });
    left.receive("one");
    left.receive("two");
    right.receive("three");
    await vi.waitFor(() => {
      expect(right.sent).toEqual(["one", "two"]);
      expect(left.sent).toEqual(["three"]);
    });
    bridge.close();
    await bridge.completed;
  });

  it("waits for queued message normalization before completing", async () => {
    const left = new FakeWebSocket();
    const right = new FakeWebSocket();
    const bridge = bridgeWebSockets(left, right, { controlCheckIntervalMs: 0 });
    let resolvePayload: (value: ArrayBuffer) => void = noop;
    let markStarted: () => void = noop;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const payload = new Promise<ArrayBuffer>((resolve) => {
      resolvePayload = resolve;
    });
    let completed = false;
    void bridge.completed.then(() => {
      completed = true;
    });

    right.receive({
      arrayBuffer: () => {
        markStarted();
        return payload;
      },
    });
    await started;
    bridge.close();
    await Promise.resolve();
    expect(completed).toBe(false);

    resolvePayload(Uint8Array.from([1, 2, 3]).buffer);
    await bridge.completed;
    expect(completed).toBe(true);
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
    right.receive("hello");
    await vi.waitFor(() => expect(bridge.rightOutputAcknowledgementBytes).toBe(5));
    left.receive('{"type":"ack","bytes":5}');
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

  it("applies product close-reason sanitization to peer and explicit closes", () => {
    const left = new FakeWebSocket();
    const right = new FakeWebSocket();
    bridgeWebSockets(left, right, {
      controlCheckIntervalMs: 0,
      sanitizeCloseReason: redactTestToken,
    });
    left.emitClose(1000, "upstream token=secret");
    expect(right.closed).toEqual({ code: 1000, reason: "upstream token=[redacted]" });

    const nextLeft = new FakeWebSocket();
    const nextRight = new FakeWebSocket();
    const bridge = bridgeWebSockets(nextLeft, nextRight, {
      controlCheckIntervalMs: 0,
      sanitizeCloseReason: redactTestToken,
    });
    bridge.close(1000, "operator token=secret");
    expect(nextLeft.closed).toEqual({ code: 1000, reason: "operator token=[redacted]" });
    expect(nextRight.closed).toEqual({ code: 1000, reason: "operator token=[redacted]" });
  });

  it("fails safely when product close-reason sanitization throws", () => {
    const left = new FakeWebSocket();
    const right = new FakeWebSocket();
    const errors: unknown[] = [];
    const bridge = bridgeWebSockets(left, right, {
      controlCheckIntervalMs: 0,
      sanitizeCloseReason: () => {
        throw new Error("sanitizer failed");
      },
      onError: (error) => errors.push(error),
    });
    bridge.close(1000, "token=secret");
    expect(left.closed).toEqual({ code: 1000, reason: "" });
    expect(right.closed).toEqual({ code: 1000, reason: "" });
    expect(errors).toHaveLength(1);
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

function noop(): void {}
