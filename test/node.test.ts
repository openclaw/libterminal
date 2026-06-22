import { describe, expect, it, vi } from "vitest";
import {
  attachLocalStdio,
  GHOSTTY_ASSET_PATHS,
  readGhosttyAsset,
  spawnLocalPty,
  type DisposableLike,
  type PtyDriver,
} from "../src/node.js";

describe("spawnLocalPty", () => {
  it("adapts an injected PTY driver into a terminal duplex", async () => {
    const fake = new FakePtyDriver();
    const outputs: string[] = [];
    const session = await spawnLocalPty({
      command: "codex",
      cwd: "/workspace",
      driver: fake,
      onOutput: (bytes) => outputs.push(new TextDecoder().decode(bytes)),
    });
    const iterator = session.output[Symbol.asyncIterator]();

    fake.emitData("ready");
    expect(new TextDecoder().decode((await iterator.next()).value)).toBe("ready");
    expect(outputs).toEqual(["ready"]);
    await session.write?.(new TextEncoder().encode("hello"));
    await session.resize?.({ columns: 100, rows: 30 });
    session.kill("SIGTERM");
    fake.emitExit(0, 15);

    await expect(session.exit).resolves.toEqual({ code: 0, signal: 15 });
    expect(fake.writes).toEqual(["hello"]);
    expect(fake.sizes).toEqual([{ columns: 100, rows: 30 }]);
    expect(fake.kills).toEqual(["SIGTERM"]);
    expect((await iterator.next()).done).toBe(true);
  });

  it("bounds queued PTY output and preserves split UTF-8 input", async () => {
    const fake = new FakePtyDriver();
    const dropped: number[] = [];
    const session = await spawnLocalPty({
      command: "codex",
      cwd: "/workspace",
      driver: fake,
      outputBufferBytes: 4,
      onOutputDrop: (bytes) => dropped.push(bytes),
    });
    fake.emitData("1234");
    fake.emitData("56");
    const iterator = session.output[Symbol.asyncIterator]();
    expect(new TextDecoder().decode((await iterator.next()).value)).toBe("56");
    expect(dropped).toEqual([4]);

    const euro = new TextEncoder().encode("€");
    await session.write?.(euro.subarray(0, 2));
    await session.write?.(euro.subarray(2));
    expect(fake.writes).toEqual(["€"]);
  });

  it("rejects invalid output buffering before spawning a PTY", async () => {
    const fake = new FakePtyDriver();

    await expect(
      spawnLocalPty({
        command: "codex",
        cwd: "/workspace",
        driver: fake,
        outputBufferBytes: 0,
      }),
    ).rejects.toThrow("outputBufferBytes must be a positive safe integer");
    expect(fake.spawnCalls).toBe(0);
  });

  it("flushes partial UTF-8 input once before closing the PTY", async () => {
    const fake = new FakePtyDriver();
    const session = await spawnLocalPty({
      command: "codex",
      cwd: "/workspace",
      driver: fake,
    });
    const euro = new TextEncoder().encode("€");

    await session.write?.(euro.subarray(0, 2));
    await session.close();
    session.kill("SIGTERM");

    expect(fake.writes).toEqual(["�"]);
    expect(fake.kills).toEqual([undefined, "SIGTERM"]);
    await expect(session.write?.(euro.subarray(2))).rejects.toMatchObject({
      code: "transport_closed",
    });
  });
});

describe("attachLocalStdio", () => {
  it("honors a signal that is already aborted before touching stdio", async () => {
    const controller = new AbortController();
    controller.abort();
    const reasons: Array<string | undefined> = [];
    await attachLocalStdio(
      {
        output: {
          [Symbol.asyncIterator]: () => ({
            next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
          }),
        },
        close: async (reason) => {
          reasons.push(reason);
        },
      },
      { signal: controller.signal },
    );
    expect(reasons).toEqual(["aborted"]);
  });

  it("stops waiting for idle output and cleans up on a later abort", async () => {
    const controller = new AbortController();
    const reasons: Array<string | undefined> = [];
    const removed: string[] = [];
    let paused = false;
    const stdin = {
      isTTY: false,
      readableFlowing: null,
      on: () => undefined,
      off: (event: string) => removed.push(`stdin:${event}`),
      pause: () => {
        paused = true;
      },
    } as unknown as NodeJS.ReadStream;
    const stdout = {
      columns: 80,
      rows: 24,
      on: () => undefined,
      off: (event: string) => removed.push(`stdout:${event}`),
      write: (_bytes: Uint8Array, callback: (error?: Error | null) => void) => {
        callback();
        return true;
      },
    } as unknown as NodeJS.WriteStream;
    const attached = attachLocalStdio(
      {
        output: neverOutput(),
        close: async (reason) => {
          reasons.push(reason);
        },
      },
      { signal: controller.signal, stdin, stdout },
    );
    controller.abort();
    await attached;
    expect(reasons).toEqual(["aborted"]);
    expect(removed).toEqual(["stdin:data", "stdout:resize"]);
    expect(paused).toBe(true);
  });

  it("serializes stdin writes before forwarding the next input chunk", async () => {
    const controller = new AbortController();
    const stdio = testStdio();
    const writes: string[] = [];
    let resolveFirstWrite: () => void = noop;
    const firstWrite = new Promise<void>((resolve) => {
      resolveFirstWrite = resolve;
    });
    const attached = attachLocalStdio(
      {
        output: neverOutput(),
        close: async () => undefined,
        write: async (bytes) => {
          writes.push(new TextDecoder().decode(bytes));
          if (writes.length === 1) {
            await firstWrite;
          }
        },
      },
      { signal: controller.signal, stdin: stdio.stdin, stdout: stdio.stdout },
    );

    stdio.input("first");
    stdio.input("second");
    await vi.waitFor(() => expect(writes).toEqual(["first"]));
    resolveFirstWrite();
    await vi.waitFor(() => expect(writes).toEqual(["first", "second"]));

    controller.abort();
    await attached;
  });

  it("restores stdio after output completes without waiting forever for pending input", async () => {
    const removed: string[] = [];
    let paused = false;
    let inputListener: (data: Buffer) => void = noop;
    let completeOutput: (result: IteratorResult<Uint8Array>) => void = noop;
    let resolveWrite: () => void = noop;
    let writeStarted: () => void = noop;
    const writeStartedPromise = new Promise<void>((resolve) => {
      writeStarted = resolve;
    });
    const stdin = {
      isTTY: false,
      readableFlowing: null,
      on: (event: string, listener: (data: Buffer) => void) => {
        if (event === "data") {
          inputListener = listener;
        }
      },
      off: (event: string) => removed.push(`stdin:${event}`),
      pause: () => {
        paused = true;
      },
    } as unknown as NodeJS.ReadStream;
    const stdout = {
      columns: 80,
      rows: 24,
      on: () => undefined,
      off: (event: string) => removed.push(`stdout:${event}`),
      write: (_bytes: Uint8Array, callback: (error?: Error | null) => void) => {
        callback();
        return true;
      },
    } as unknown as NodeJS.WriteStream;
    const output = {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<Uint8Array>>((resolve) => {
            completeOutput = resolve;
          }),
      }),
    };
    const attached = attachLocalStdio(
      {
        output,
        close: async () => undefined,
        write: async () => {
          writeStarted();
          await new Promise<void>((resolve) => {
            resolveWrite = resolve;
          });
        },
      },
      { stdin, stdout },
    );

    inputListener(Buffer.from("pending"));
    await writeStartedPromise;
    completeOutput({ done: true, value: undefined });
    await attached;
    expect(removed).toEqual(["stdin:data", "stdout:resize"]);
    expect(paused).toBe(true);
    resolveWrite();
  });

  it("rejects and restores stdio when writing stdin fails", async () => {
    const stdio = testStdio();
    const attached = attachLocalStdio(
      {
        output: neverOutput(),
        close: async () => undefined,
        write: async () => {
          throw new Error("stdin write failed");
        },
      },
      { stdin: stdio.stdin, stdout: stdio.stdout },
    );

    stdio.input("broken");
    await expect(attached).rejects.toThrow("stdin write failed");
  });

  it("suppresses iterator cleanup failures after an abort", async () => {
    const controller = new AbortController();
    const returned = vi.fn(async () => {
      throw new Error("iterator cleanup failed");
    });
    const output = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
        return: returned,
      }),
    };
    const stdio = testStdio();
    const attached = attachLocalStdio(
      { output, close: async () => undefined },
      { signal: controller.signal, stdin: stdio.stdin, stdout: stdio.stdout },
    );

    controller.abort();
    await expect(attached).resolves.toBeUndefined();
    await Promise.resolve();
    expect(returned).toHaveBeenCalledOnce();
  });

  it("closes the output iterator when stdout fails", async () => {
    let returned = false;
    const output = {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: false as const, value: new Uint8Array([1]) }),
        return: async () => {
          returned = true;
          return { done: true as const, value: undefined };
        },
      }),
    };
    const stdin = {
      isTTY: false,
      readableFlowing: null,
      on: () => undefined,
      off: () => undefined,
      pause: () => undefined,
    } as unknown as NodeJS.ReadStream;
    const stdout = {
      columns: 80,
      rows: 24,
      on: () => undefined,
      off: () => undefined,
      write: (_bytes: Uint8Array, callback: (error?: Error | null) => void) => {
        callback(new Error("EPIPE"));
        return false;
      },
    } as unknown as NodeJS.WriteStream;

    await expect(
      attachLocalStdio({ output, close: async () => undefined }, { stdin, stdout }),
    ).rejects.toThrow("EPIPE");
    expect(returned).toBe(true);
  });

  it("restores stdio when closing a failed output iterator also fails", async () => {
    const rawModes: boolean[] = [];
    const removed: string[] = [];
    const output = {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: false as const, value: new Uint8Array([1]) }),
        return: async () => {
          throw new Error("return failed");
        },
      }),
    };
    const stdin = {
      isTTY: true,
      isRaw: false,
      readableFlowing: true,
      setRawMode: (raw: boolean) => rawModes.push(raw),
      resume: () => undefined,
      on: () => undefined,
      off: (event: string) => removed.push(`stdin:${event}`),
      pause: () => {
        throw new Error("flowing stdin must stay flowing");
      },
    } as unknown as NodeJS.ReadStream;
    const stdout = {
      columns: 80,
      rows: 24,
      on: () => undefined,
      off: (event: string) => removed.push(`stdout:${event}`),
      write: (_bytes: Uint8Array, callback: (error?: Error | null) => void) => {
        callback(new Error("EPIPE"));
        return false;
      },
    } as unknown as NodeJS.WriteStream;

    await expect(
      attachLocalStdio({ output, close: async () => undefined }, { stdin, stdout }),
    ).rejects.toThrow("return failed");
    expect(rawModes).toEqual([true, false]);
    expect(removed).toEqual(["stdin:data", "stdout:resize"]);
  });

  it("restores stdio when the initial resize fails", async () => {
    const rawModes: boolean[] = [];
    const removed: string[] = [];
    let paused = false;
    const stdin = {
      isTTY: true,
      isRaw: false,
      readableFlowing: null,
      setRawMode: (raw: boolean) => rawModes.push(raw),
      resume: () => undefined,
      on: () => undefined,
      off: (event: string) => removed.push(`stdin:${event}`),
      pause: () => {
        paused = true;
      },
    } as unknown as NodeJS.ReadStream;
    const stdout = {
      columns: 80,
      rows: 24,
      on: () => undefined,
      off: (event: string) => removed.push(`stdout:${event}`),
    } as unknown as NodeJS.WriteStream;

    await expect(
      attachLocalStdio(
        { output: neverOutput(), close: async () => undefined },
        {
          stdin,
          stdout,
          onResize: () => {
            throw new Error("resize failed");
          },
        },
      ),
    ).rejects.toThrow("resize failed");
    expect(rawModes).toEqual([true, false]);
    expect(removed).toEqual(["stdin:data", "stdout:resize"]);
    expect(paused).toBe(true);
  });

  it("rejects and restores stdio when a later resize rejects", async () => {
    const removed: string[] = [];
    let resizeListener: () => void = noop;
    let resizeCalls = 0;
    let resolveInitialResize: () => void = noop;
    let rejectLaterResize: (error: Error) => void = noop;
    let completeOutput: (result: IteratorResult<Uint8Array>) => void = noop;
    const initialResize = new Promise<void>((resolve) => {
      resolveInitialResize = resolve;
    });
    const laterResize = new Promise<void>((_, reject) => {
      rejectLaterResize = reject;
    });
    const output = {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<Uint8Array>>((resolve) => {
            completeOutput = resolve;
          }),
      }),
    };
    const stdin = {
      isTTY: false,
      readableFlowing: true,
      on: () => undefined,
      off: (event: string) => removed.push(`stdin:${event}`),
      pause: () => undefined,
    } as unknown as NodeJS.ReadStream;
    const stdout = {
      columns: 80,
      rows: 24,
      on: (event: string, listener: () => void) => {
        if (event === "resize") {
          resizeListener = listener;
        }
      },
      off: (event: string) => removed.push(`stdout:${event}`),
    } as unknown as NodeJS.WriteStream;
    const attached = attachLocalStdio(
      {
        output,
        close: async () => undefined,
        resize: async () => {
          resizeCalls += 1;
          if (resizeCalls === 1) {
            resolveInitialResize();
            return;
          }
          return laterResize;
        },
      },
      { stdin, stdout },
    );

    await initialResize;
    resizeListener();
    completeOutput({ done: true, value: undefined });
    rejectLaterResize(new Error("resize rejected"));

    await expect(attached).rejects.toThrow("resize rejected");
    expect(removed).toEqual(["stdin:data", "stdout:resize"]);
  });
});

describe("readGhosttyAsset", () => {
  it("exports and resolves the bundled Ghostty asset manifest", async () => {
    expect(GHOSTTY_ASSET_PATHS).toEqual({
      module: "/vendor/ghostty-web.js",
      wasm: "/vendor/ghostty-vt.wasm",
      browserExternal: "/vendor/__vite-browser-external-2447137e.js",
    });
    await expect(readGhosttyAsset("/missing")).resolves.toBeNull();
    const wasm = await readGhosttyAsset(GHOSTTY_ASSET_PATHS.wasm);
    expect(wasm?.contentType).toBe("application/wasm");
    expect(wasm?.body.byteLength).toBeGreaterThan(0);
  });
});

class FakePtyDriver implements PtyDriver {
  spawnCalls = 0;
  readonly writes: string[] = [];
  readonly sizes: Array<{ columns: number; rows: number }> = [];
  readonly kills: Array<string | undefined> = [];
  private dataListener: (data: string) => void = () => undefined;
  private exitListener: (event: { exitCode: number; signal?: number }) => void = () => undefined;

  spawn() {
    this.spawnCalls += 1;
    return {
      onData: (listener: (data: string) => void): DisposableLike => {
        this.dataListener = listener;
        return { dispose: () => undefined };
      },
      onExit: (
        listener: (event: { exitCode: number; signal?: number }) => void,
      ): DisposableLike => {
        this.exitListener = listener;
        return { dispose: () => undefined };
      },
      write: (data: string) => this.writes.push(data),
      resize: (columns: number, rows: number) => this.sizes.push({ columns, rows }),
      kill: (signal?: string) => this.kills.push(signal),
    };
  }

  emitData(data: string): void {
    this.dataListener(data);
  }

  emitExit(exitCode: number, signal: number): void {
    this.exitListener({ exitCode, signal });
  }
}

function neverOutput(): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
    }),
  };
}

function testStdio(): {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  input(value: string): void;
} {
  let inputListener: (data: Buffer) => void = noop;
  const stdin = {
    isTTY: false,
    readableFlowing: null,
    on: (event: string, listener: (data: Buffer) => void) => {
      if (event === "data") {
        inputListener = listener;
      }
    },
    off: () => undefined,
    pause: () => undefined,
  } as unknown as NodeJS.ReadStream;
  const stdout = {
    columns: 80,
    rows: 24,
    on: () => undefined,
    off: () => undefined,
    write: (_bytes: Uint8Array, callback: (error?: Error | null) => void) => {
      callback();
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  return {
    stdin,
    stdout,
    input: (value) => inputListener(Buffer.from(value)),
  };
}

function noop(): void {}
