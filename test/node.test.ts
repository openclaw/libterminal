import { describe, expect, it } from "vitest";
import {
  attachLocalStdio,
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
    const stdin = {
      isTTY: false,
      on: () => undefined,
      off: (event: string) => removed.push(`stdin:${event}`),
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
      on: () => undefined,
      off: () => undefined,
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
});

describe("readGhosttyAsset", () => {
  it("resolves the bundled Ghostty module and WASM", async () => {
    await expect(readGhosttyAsset("/missing")).resolves.toBeNull();
    const wasm = await readGhosttyAsset("/vendor/ghostty-vt.wasm");
    expect(wasm?.contentType).toBe("application/wasm");
    expect(wasm?.body.byteLength).toBeGreaterThan(0);
  });
});

class FakePtyDriver implements PtyDriver {
  readonly writes: string[] = [];
  readonly sizes: Array<{ columns: number; rows: number }> = [];
  readonly kills: Array<string | undefined> = [];
  private dataListener: (data: string) => void = () => undefined;
  private exitListener: (event: { exitCode: number; signal?: number }) => void = () => undefined;

  spawn() {
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
