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

    await waitForFrames(frames, 2);
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
    await waitForSockets(sockets, 2);

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
    await waitForSockets(sockets, 2);
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

async function waitForFrames(
  frames: Array<{ sessionId: string; payload: string }>,
  count: number,
): Promise<void> {
  for (let attempt = 0; attempt < 20 && frames.length < count; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve));
  }
  expect(frames).toHaveLength(count);
}

async function waitForSockets(sockets: TestTerminalHubSocket[], count: number): Promise<void> {
  for (let attempt = 0; attempt < 20 && sockets.length < count; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve));
  }
  expect(sockets).toHaveLength(count);
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copied = new Uint8Array(bytes.byteLength);
  copied.set(bytes);
  return copied.buffer;
}

function noop(): void {}
