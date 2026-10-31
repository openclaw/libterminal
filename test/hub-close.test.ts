import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { TerminalHubClient } from "../src/browser.js";
import { encodeTerminalFrame, TerminalMessageType } from "../src/protocol.js";

describe("TerminalHubClient native WebSocket teardown", () => {
  it("drops queued frames as soon as the caller closes", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    let client: TerminalHubClient | undefined;
    try {
      await once(server, "listening");
      const onFrame = vi.fn();
      let markClosed!: () => void;
      const closed = new Promise<void>((resolve) => {
        markClosed = resolve;
      });
      client = new TerminalHubClient({
        url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
        socketFactory: (url) => {
          const socket = new WebSocket(url);
          socket.addEventListener("message", () => queueMicrotask(() => client?.close()));
          return socket;
        },
        onFrame,
        onClose: markClosed,
      });
      const connected = once(server, "connection");
      client.connect();
      const [peer] = await connected;
      peer.send(
        encodeTerminalFrame({ type: TerminalMessageType.Output, payload: new Uint8Array([65]) }),
      );
      await closed;
      expect(onFrame).not.toHaveBeenCalled();
    } finally {
      client?.close();
      for (const peer of server.clients) {
        peer.terminate();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each([
    {
      name: "reserved code",
      code: 1006,
      reason: "done",
      expectedCode: 1000,
      expectedReason: "done",
    },
    {
      name: "out-of-range code",
      code: 999,
      reason: "done",
      expectedCode: 1000,
      expectedReason: "done",
    },
    {
      name: "browser-disallowed code",
      code: 1001,
      reason: "done",
      expectedCode: 1000,
      expectedReason: "done",
    },
    {
      name: "oversized ASCII",
      code: 1000,
      reason: "x".repeat(200),
      expectedCode: 1000,
      expectedReason: "x".repeat(123),
    },
    {
      name: "fractional code",
      code: 4001.5,
      reason: "done",
      expectedCode: 1000,
      expectedReason: "done",
    },
    {
      name: "oversized Unicode",
      code: 1000,
      reason: "🦞".repeat(40),
      expectedCode: 1000,
      expectedReason: "🦞".repeat(30),
    },
    {
      name: "valid application code and whitespace",
      code: 4001,
      reason: " keep spaces ",
      expectedCode: 4001,
      expectedReason: " keep spaces ",
    },
    {
      name: "default arguments",
      code: undefined,
      reason: undefined,
      expectedCode: 1000,
      expectedReason: "terminal hub closed",
    },
  ])("closes the real peer for $name", async ({ code, reason, expectedCode, expectedReason }) => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    try {
      await once(server, "listening");
      const errors: unknown[] = [];
      const closes: Array<{ code?: number; reason?: string }> = [];
      let markOpen: (() => void) | undefined;
      const opened = new Promise<void>((resolve) => {
        markOpen = resolve;
      });
      const client = new TerminalHubClient({
        url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
        onOpen: () => markOpen?.(),
        onClose: (event) => closes.push(event),
        onError: (error) => errors.push(error),
      });
      const connected = once(server, "connection");
      client.connect();
      const [peer] = await connected;
      await opened;
      let peerClose: { code: number; reason: string } | undefined;
      peer.once("close", (closeCode: number, closeReason: Buffer) => {
        peerClose = { code: closeCode, reason: closeReason.toString() };
      });

      client.close(code, reason);

      await vi.waitFor(() => {
        expect(peerClose).toEqual({ code: expectedCode, reason: expectedReason });
        expect(closes).toHaveLength(1);
      });
      expect(closes[0]).toMatchObject({ code: expectedCode, reason: expectedReason });
      expect(client.isOpen).toBe(false);
      expect(server.clients.size).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      for (const peer of server.clients) {
        peer.terminate();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
