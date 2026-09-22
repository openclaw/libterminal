import { describe, expect, it, vi } from "vitest";
import {
  TerminalHubClient,
  attachTerminalStream,
  createGhosttyTerminal,
  type TerminalHubWebSocket,
} from "../src/browser.js";
import { TerminalMessageType, decodeTerminalFrame, encodeTerminalFrame } from "../src/protocol.js";

describe("createGhosttyTerminal", () => {
  it("preserves abort reasons raised while Ghostty is loading", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled by caller");
    let finishLoad: ((value: unknown) => void) | undefined;
    const loaded = new Promise((resolve) => {
      finishLoad = resolve;
    });
    const module = {
      Ghostty: { load: () => loaded },
    } as unknown as typeof import("ghostty-web");

    const created = createGhosttyTerminal({
      parent: {} as HTMLElement,
      runtimeOptions: { module },
      signal: controller.signal,
    });
    controller.abort(reason);
    finishLoad?.({});

    await expect(created).rejects.toBe(reason);
  });

  it("removes the caller abort listener when the terminal is disposed", async () => {
    const listeners = new Set<() => void>();
    const signal = {
      aborted: false,
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    } as unknown as AbortSignal;
    const controller = await createGhosttyTerminal({
      parent: {} as HTMLElement,
      signal,
      runtime: {
        ghostty: {},
        Terminal: TestGhosttyTerminal,
        FitAddon: TestGhosttyFitAddon,
      } as never,
    });

    expect(listeners.size).toBe(1);
    controller.dispose();
    expect(listeners.size).toBe(0);
  });
});

describe("attachTerminalStream", () => {
  it.each([
    ["read", "sync"],
    ["read", "async"],
    ["write", "sync"],
    ["write", "async"],
  ])("preserves a %s failure when %s iterator cleanup fails", async (operation, cleanup) => {
    const failure = new Error(`${operation} failed`);
    const cleanupFailure = new Error("cleanup failed");
    const returned = vi.fn(() => {
      if (cleanup === "sync") {
        throw cleanupFailure;
      }
      return Promise.reject(cleanupFailure);
    });
    const source = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          if (operation === "read") {
            throw failure;
          }
          return { done: false as const, value: new Uint8Array([1]) };
        },
        return: returned,
      }),
    };
    await expect(
      attachTerminalStream(
        {
          write: () => {
            throw failure;
          },
        },
        source,
      ),
    ).rejects.toBe(failure);
    expect(returned).toHaveBeenCalledOnce();
  });

  it.each([
    ["before attachment", "sync"],
    ["before attachment", "async"],
    ["while reading", "sync"],
    ["while reading", "async"],
  ])("suppresses %s abort cleanup errors from a %s return", async (when, cleanup) => {
    const controller = new AbortController();
    const returned = vi.fn(() => {
      const failure = new Error("cleanup failed");
      if (cleanup === "sync") {
        throw failure;
      }
      return Promise.reject(failure);
    });
    if (when === "before attachment") {
      controller.abort();
    }
    const source = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
        return: returned,
      }),
    };
    const attached = attachTerminalStream({ write: vi.fn() }, source, controller.signal);
    controller.abort();
    await expect(attached).resolves.toBeUndefined();
    expect(returned).toHaveBeenCalledOnce();
  });

  it("stops waiting for cleanup on abort while retaining the original failure", async () => {
    const controller = new AbortController();
    const failure = new Error("write failed");
    let rejectCleanup!: (reason: unknown) => void;
    const cleanup = new Promise<IteratorResult<Uint8Array>>((_, reject) => {
      rejectCleanup = reject;
    });
    const returned = vi.fn(() => cleanup);
    const rejected = vi.fn();
    const attached = attachTerminalStream(
      {
        write: () => {
          throw failure;
        },
      },
      {
        [Symbol.asyncIterator]: () => ({
          next: async () => ({ done: false as const, value: new Uint8Array([1]) }),
          return: returned,
        }),
      },
      controller.signal,
    ).catch(rejected);
    try {
      await vi.waitFor(() => expect(returned).toHaveBeenCalledOnce());
      controller.abort();
      await vi.waitFor(() => expect(rejected).toHaveBeenCalledWith(failure));
    } finally {
      rejectCleanup(new Error("late cleanup failure"));
      await attached;
    }
  });

  it.each(["before attachment", "while a read resolves"])(
    "does not write buffered output aborted %s",
    async (when) => {
      const controller = new AbortController();
      const queued = [new Uint8Array([1]), new Uint8Array([2])];
      const returned = vi.fn(async () => ({ done: true as const, value: undefined }));
      const source = {
        [Symbol.asyncIterator]: () => ({
          next: async () =>
            queued.length
              ? { done: false as const, value: queued.shift()! }
              : { done: true as const, value: undefined },
          return: returned,
        }),
      };
      const write = vi.fn();
      if (when === "before attachment") {
        controller.abort();
      }
      const attached = attachTerminalStream({ write }, source, controller.signal);
      controller.abort();
      await attached;
      expect(write).not.toHaveBeenCalled();
      expect(returned).toHaveBeenCalledOnce();
    },
  );

  it("does not read another chunk after a write callback aborts", async () => {
    const controller = new AbortController();
    const queued = [new Uint8Array([1]), new Uint8Array([2])];
    const next = vi.fn(async () =>
      queued.length
        ? { done: false as const, value: queued.shift()! }
        : { done: true as const, value: undefined },
    );
    const returned = vi.fn(async () => ({ done: true as const, value: undefined }));
    const write = vi.fn(() => controller.abort());
    await attachTerminalStream(
      { write },
      { [Symbol.asyncIterator]: () => ({ next, return: returned }) },
      controller.signal,
    );
    expect(write).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledOnce();
    expect(returned).toHaveBeenCalledOnce();
  });

  it("writes terminal byte chunks in order", async () => {
    const writes: string[] = [];
    await attachTerminalStream(
      {
        write: (chunk: string | Uint8Array) => {
          writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
        },
      },
      chunks("one", "two"),
    );
    expect(writes).toEqual(["one", "two"]);
  });

  it("stops waiting when aborted", async () => {
    const controller = new AbortController();
    const attached = attachTerminalStream({ write: () => undefined }, never(), controller.signal);
    controller.abort();
    await expect(attached).resolves.toBeUndefined();
  });

  it("closes the source iterator when terminal writes fail", async () => {
    let returned = false;
    const source = {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: false as const, value: new Uint8Array([1]) }),
        return: async () => {
          returned = true;
          return { done: true as const, value: undefined };
        },
      }),
    };
    await expect(
      attachTerminalStream(
        {
          write: () => {
            throw new Error("terminal disposed");
          },
        },
        source,
      ),
    ).rejects.toThrow("terminal disposed");
    expect(returned).toBe(true);
  });
});

describe("TerminalHubClient", () => {
  it.each(["Buffer", "ArrayBuffer", "DataView"])(
    "captures %s bytes before queuing frame delivery",
    async (kind) => {
      const socket = new TestTerminalHubSocket();
      const frames: string[] = [];
      const client = new TerminalHubClient({
        url: "wss://terminal.example",
        socketFactory: () => socket,
        onFrame: (frame) => frames.push(new TextDecoder().decode(frame.payload)),
      });
      client.connect();
      socket.open();
      const source = Buffer.from(
        encodeTerminalFrame({
          type: TerminalMessageType.Output,
          payload: new TextEncoder().encode("safe"),
        }),
      );
      const buffer = ownedArrayBuffer(source);
      socket.receive(
        kind === "Buffer" ? source : kind === "ArrayBuffer" ? buffer : new DataView(buffer),
      );
      source.fill(0);
      new Uint8Array(buffer).fill(0);

      await vi.waitFor(() => expect(frames).toEqual(["safe"]));
      client.close();
    },
  );

  it.each(["Buffer", "ArrayBuffer", "arrayBuffer method"])(
    "owns normalized %s frames from injected transports",
    async (kind) => {
      const socket = new TestTerminalHubSocket();
      const frames: Uint8Array[] = [];
      const client = new TerminalHubClient({
        url: "wss://terminal.example",
        socketFactory: () => socket,
        onFrame: (frame) => frames.push(frame.payload),
      });
      client.connect();
      socket.open();
      const buffer = new Uint8Array(
        encodeTerminalFrame({
          type: TerminalMessageType.Output,
          payload: new TextEncoder().encode("safe"),
        }),
      ).buffer;
      const source = kind === "Buffer" ? Buffer.from(buffer) : new Uint8Array(buffer);
      socket.receive(
        kind === "Buffer"
          ? source
          : kind === "ArrayBuffer"
            ? buffer
            : { arrayBuffer: async () => buffer },
      );
      await vi.waitFor(() => expect(frames).toHaveLength(1));
      source.fill(120);
      expect(new TextDecoder().decode(frames[0])).toBe("safe");
      client.close();
    },
  );

  it("handles conversion failures while an earlier frame is still queued", async () => {
    const socket = new TestTerminalHubSocket();
    const events: unknown[] = [];
    let resolveFirst!: (bytes: ArrayBuffer) => void;
    const first = new Promise<ArrayBuffer>((resolve) => {
      resolveFirst = resolve;
    });
    const failure = new Error("conversion failed");
    const client = new TerminalHubClient({
      url: "wss://terminal.example",
      socketFactory: () => socket,
      onFrame: () => events.push("frame"),
      onError: (error) => events.push(error),
    });
    client.connect();
    socket.open();
    socket.receive({ arrayBuffer: () => first });
    socket.receive({
      arrayBuffer: async () => {
        throw failure;
      },
    });
    await new Promise((resolve) => setTimeout(resolve));
    expect(events).toEqual([]);
    resolveFirst(ownedArrayBuffer(encodeTerminalFrame({ type: TerminalMessageType.Output })));
    await vi.waitFor(() => expect(events).toEqual(["frame", failure]));
    client.close();
  });

  it("sends the protocol hello and delivers decoded frames in order", async () => {
    const socket = new TestTerminalHubSocket();
    const frames: Array<{ sessionId: string; payload: string }> = [];
    const client = new TerminalHubClient({
      url: "wss://terminal.example",
      socketFactory: () => socket,
      onFrame: (frame) => {
        frames.push({
          sessionId: frame.sessionId,
          payload: new TextDecoder().decode(frame.payload),
        });
      },
    });

    client.connect();
    socket.open();
    expect(decodeTerminalFrame(socket.sent[0] as Uint8Array)).toMatchObject({
      type: TerminalMessageType.Hello,
      sessionId: "",
    });

    socket.receive(
      new Blob([
        ownedArrayBuffer(
          encodeTerminalFrame({
            type: TerminalMessageType.Output,
            sessionId: "IS-1",
            payload: new TextEncoder().encode("first"),
          }),
        ),
      ]),
    );
    socket.receive(
      encodeTerminalFrame({
        type: TerminalMessageType.Output,
        sessionId: "IS-2",
        payload: new TextEncoder().encode("second"),
      }),
    );

    await vi.waitFor(() => expect(frames).toHaveLength(2));
    expect(frames).toEqual([
      { sessionId: "IS-1", payload: "first" },
      { sessionId: "IS-2", payload: "second" },
    ]);
  });

  it("uses caller-supplied frame limits when sending", () => {
    const socket = new TestTerminalHubSocket();
    const client = new TerminalHubClient({
      url: "wss://terminal.example",
      frameLimits: { maxFrameBytes: 2 * 1024 * 1024 },
      socketFactory: () => socket,
    });

    client.connect();
    socket.open();
    expect(
      client.send({
        type: TerminalMessageType.Output,
        sessionId: "IS-1",
        payload: new Uint8Array(1024 * 1024),
      }),
    ).toBe(true);
  });

  it("reconnects only while the application still needs the transport", async () => {
    const sockets: TestTerminalHubSocket[] = [];
    const client = new TerminalHubClient({
      url: "wss://terminal.example",
      reconnectDelayMs: 1,
      shouldReconnect: () => true,
      socketFactory: () => {
        const socket = new TestTerminalHubSocket();
        sockets.push(socket);
        return socket;
      },
    });

    client.connect();
    sockets[0]?.open();
    sockets[0]?.emitClose();
    await vi.waitFor(() => expect(sockets).toHaveLength(2));

    client.close();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sockets).toHaveLength(2);
  });

  it("does not let a stalled prior socket block frames after reconnecting", async () => {
    const sockets: TestTerminalHubSocket[] = [];
    const frames: string[] = [];
    let resolveOldPayload: (value: ArrayBuffer) => void = noop;
    const oldPayload = new Promise<ArrayBuffer>((resolve) => {
      resolveOldPayload = resolve;
    });
    const client = new TerminalHubClient({
      url: "wss://terminal.example",
      reconnectDelayMs: 1,
      shouldReconnect: () => true,
      socketFactory: () => {
        const socket = new TestTerminalHubSocket();
        sockets.push(socket);
        return socket;
      },
      onFrame: (frame) => frames.push(new TextDecoder().decode(frame.payload)),
    });

    client.connect();
    sockets[0]?.open();
    sockets[0]?.receive({ arrayBuffer: () => oldPayload });
    await Promise.resolve();
    sockets[0]?.emitClose();
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    sockets[1]?.open();
    sockets[1]?.receive(
      encodeTerminalFrame({
        type: TerminalMessageType.Output,
        sessionId: "IS-2",
        payload: new TextEncoder().encode("new"),
      }),
    );

    await vi.waitFor(() => expect(frames).toEqual(["new"]));
    resolveOldPayload(
      ownedArrayBuffer(
        encodeTerminalFrame({
          type: TerminalMessageType.Output,
          sessionId: "IS-1",
          payload: new TextEncoder().encode("old"),
        }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve));
    expect(frames).toEqual(["new"]);
    client.close();
  });

  it.each([1001, 1011, 4001])("preserves code %i when an injected transport accepts it", (code) => {
    const socket = new TestTerminalHubSocket();
    const close = vi.spyOn(socket, "close");
    const client = new TerminalHubClient({
      url: "wss://terminal.example",
      socketFactory: () => socket,
    });
    client.connect();
    socket.open();

    client.close(code, "done");

    expect(close.mock.calls).toEqual([[code, "done"]]);
    expect(socket.readyState).toBe(3);
  });

  it.each([1011.5, 4001.5])(
    "normalizes fractional close code %f before calling the transport",
    (code) => {
      const socket = new TestTerminalHubSocket();
      const close = vi.spyOn(socket, "close");
      const client = new TerminalHubClient({
        url: "wss://terminal.example",
        socketFactory: () => socket,
      });
      client.connect();
      socket.open();

      client.close(code, "done");

      expect(close.mock.calls).toEqual([[1000, "done"]]);
      expect(socket.readyState).toBe(3);
    },
  );

  it("retries without arguments when both coded close attempts fail", () => {
    const socket = new TestTerminalHubSocket();
    const close = vi
      .spyOn(socket, "close")
      .mockImplementationOnce(() => {
        throw new Error("first attempt");
      })
      .mockImplementationOnce(() => {
        throw new Error("second attempt");
      });
    const client = new TerminalHubClient({
      url: "wss://terminal.example",
      socketFactory: () => socket,
    });
    client.connect();
    socket.open();

    client.close();

    expect(close.mock.calls).toEqual([
      [1000, "terminal hub closed"],
      [1000, "terminal hub closed"],
      [],
    ]);
    expect(socket.readyState).toBe(3);
  });

  it("reports a failed teardown and retains the socket for retry", () => {
    const socket = new TestTerminalHubSocket();
    const failure = new Error("close unavailable");
    const errors: unknown[] = [];
    const close = vi.spyOn(socket, "close").mockImplementation(() => {
      throw failure;
    });
    const client = new TerminalHubClient({
      url: "wss://terminal.example",
      socketFactory: () => socket,
      onError: (error) => errors.push(error),
    });
    client.connect();
    socket.open();

    client.close();

    expect(close).toHaveBeenCalledTimes(3);
    expect(errors).toEqual([failure]);
    expect(client.isOpen).toBe(true);
    close.mockRestore();
    client.close();
    expect(socket.readyState).toBe(3);
    expect(client.isOpen).toBe(false);
  });

  it("closes the socket after native close rejects reserved codes", () => {
    const socket = new NativeCloseSocket();
    const errors: unknown[] = [];
    const client = new TerminalHubClient({
      url: "wss://terminal.example",
      socketFactory: () => socket,
      onError: (error) => errors.push(error),
    });

    client.connect();
    socket.open();
    client.close(1006);

    expect(socket.readyState).toBe(3);
    expect(socket.closeCalls.some((call) => call.code === 1000)).toBe(true);
    expect(client.isOpen).toBe(false);
    expect(errors).toEqual([]);
  });

  it("closes the socket after native close rejects an oversized reason", () => {
    const socket = new NativeCloseSocket();
    const client = new TerminalHubClient({
      url: "wss://terminal.example",
      socketFactory: () => socket,
    });

    client.connect();
    socket.open();
    client.close(1000, "x".repeat(200));

    expect(socket.readyState).toBe(3);
    const successful = socket.closeCalls.find(
      (call) => new TextEncoder().encode(call.reason ?? "").byteLength <= 123,
    );
    expect(successful).toBeDefined();
    expect(new TextEncoder().encode(successful?.reason ?? "").byteLength).toBeLessThanOrEqual(123);
    expect(client.isOpen).toBe(false);
  });
});

async function* chunks(...values: string[]): AsyncIterable<Uint8Array> {
  for (const value of values) {
    yield new TextEncoder().encode(value);
  }
}

function never(): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
    }),
  };
}

class TestTerminalHubSocket implements TerminalHubWebSocket {
  readyState = 0;
  binaryType?: string;
  readonly sent: Array<string | ArrayBuffer | ArrayBufferView | Blob> = [];
  private readonly opens = new Set<() => void>();
  private readonly messages = new Set<(event: { data: unknown }) => void>();
  private readonly closes = new Set<(event: { code?: number; reason?: string }) => void>();
  private readonly errors = new Set<() => void>();

  send(data: string | ArrayBuffer | ArrayBufferView | Blob): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.emitClose(code, reason);
  }

  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener:
      | (() => void)
      | ((event: { data: unknown }) => void)
      | ((event: { code?: number; reason?: string }) => void),
  ): void {
    if (type === "open") {
      this.opens.add(listener as () => void);
    } else if (type === "message") {
      this.messages.add(listener as (event: { data: unknown }) => void);
    } else if (type === "close") {
      this.closes.add(listener as (event: { code?: number; reason?: string }) => void);
    } else {
      this.errors.add(listener as () => void);
    }
  }

  removeEventListener(
    type: "open" | "message" | "close" | "error",
    listener:
      | (() => void)
      | ((event: { data: unknown }) => void)
      | ((event: { code?: number; reason?: string }) => void),
  ): void {
    if (type === "open") {
      this.opens.delete(listener as () => void);
    } else if (type === "message") {
      this.messages.delete(listener as (event: { data: unknown }) => void);
    } else if (type === "close") {
      this.closes.delete(listener as (event: { code?: number; reason?: string }) => void);
    } else {
      this.errors.delete(listener as () => void);
    }
  }

  open(): void {
    this.readyState = 1;
    for (const listener of this.opens) {
      listener();
    }
  }

  receive(data: unknown): void {
    for (const listener of this.messages) {
      listener({ data });
    }
  }

  emitClose(code = 1000, reason = ""): void {
    this.readyState = 3;
    for (const listener of this.closes) {
      listener({ code, reason });
    }
  }
}

class NativeCloseSocket extends TestTerminalHubSocket {
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) {
      throw new Error(`InvalidAccessError: invalid close code ${code}`);
    }
    if (new TextEncoder().encode(reason ?? "").byteLength > 123) {
      throw new Error("SyntaxError: close reason longer than 123 bytes");
    }
    super.close(code, reason);
  }
}

class TestGhosttyTerminal {
  readonly options: { disableStdin?: boolean };

  constructor(options: { disableStdin?: boolean }) {
    this.options = options;
  }

  loadAddon(): void {}

  open(): void {}

  onData(): { dispose(): void } {
    return { dispose: () => undefined };
  }

  onResize(): { dispose(): void } {
    return { dispose: () => undefined };
  }

  resize(): void {}

  write(): void {}

  dispose(): void {}
}

class TestGhosttyFitAddon {
  fit(): void {}

  observeResize(): void {}

  dispose(): void {}
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copied = new Uint8Array(bytes.byteLength);
  copied.set(bytes);
  return copied.buffer;
}

function noop(): void {}
import { Buffer } from "node:buffer";
