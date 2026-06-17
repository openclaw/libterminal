import { describe, expect, it } from "vitest";
import {
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
