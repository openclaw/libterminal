import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  assertTerminalSize,
  LibterminalError,
  type TerminalDuplex,
  type TerminalExit,
  type TerminalSize,
} from "./index.js";

export type DisposableLike = {
  dispose(): void;
};

export type PtyProcessLike = {
  onData(listener: (data: string) => void): DisposableLike;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): DisposableLike;
  write(data: string): void;
  resize(columns: number, rows: number): void;
  kill(signal?: string): void;
};

export type PtySpawnOptions = {
  name: string;
  columns: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
};

export type PtyDriver = {
  spawn(command: string, args: string[], options: PtySpawnOptions): PtyProcessLike;
};

export type SpawnLocalPtyOptions = {
  command: string;
  args?: string[];
  cwd: string;
  env?: Record<string, string>;
  name?: string;
  size?: TerminalSize;
  driver?: PtyDriver;
  signal?: AbortSignal;
  onOutput?: (bytes: Uint8Array) => void;
  outputBufferBytes?: number;
  onOutputDrop?: (droppedBytes: number) => void;
};

export type LocalPtySession = TerminalDuplex & {
  readonly exit: Promise<TerminalExit>;
  kill(signal?: string): void;
};

export type AttachLocalStdioOptions = {
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  signal?: AbortSignal;
  onResize?: (size: TerminalSize) => void;
};

export type GhosttyAsset = {
  body: Uint8Array;
  contentType: string;
};

const textEncoder = new TextEncoder();

export async function loadNodePtyDriver(): Promise<PtyDriver> {
  await ensureNodePtySpawnHelperExecutable();
  try {
    const module = await import("node-pty");
    return {
      spawn: (command, args, options) =>
        module.spawn(command, args, {
          name: options.name,
          cols: options.columns,
          rows: options.rows,
          cwd: options.cwd,
          env: options.env,
        }),
    };
  } catch (cause) {
    throw new LibterminalError("pty_unavailable", "node-pty is unavailable", { cause });
  }
}

export async function spawnLocalPty(options: SpawnLocalPtyOptions): Promise<LocalPtySession> {
  throwIfAborted(options.signal);
  const driver = options.driver ?? (await loadNodePtyDriver());
  throwIfAborted(options.signal);
  const size = assertTerminalSize(options.size ?? { columns: 120, rows: 34 });
  const inputDecoder = new TextDecoder();
  const terminal = driver.spawn(options.command, options.args ?? [], {
    name: options.name ?? process.env.TERM ?? "xterm-256color",
    columns: size.columns,
    rows: size.rows,
    cwd: options.cwd,
    env: options.env ?? currentEnvironment(),
  });
  const output = new AsyncByteQueue(options.outputBufferBytes, options.onOutputDrop);
  const dataSubscription = terminal.onData((data) => {
    const bytes = textEncoder.encode(data);
    output.push(bytes);
    options.onOutput?.(bytes.slice());
  });
  let exitSubscription: DisposableLike;
  const exit = new Promise<TerminalExit>((resolve) => {
    exitSubscription = terminal.onExit(({ exitCode, signal }) => {
      dataSubscription.dispose();
      exitSubscription.dispose();
      output.close();
      resolve({ code: exitCode, signal: signal ?? null });
    });
  });
  const abort = () => terminal.kill();
  options.signal?.addEventListener("abort", abort, { once: true });
  void exit.finally(() => options.signal?.removeEventListener("abort", abort));

  return {
    output,
    exit,
    write: async (bytes) => {
      const decoded = inputDecoder.decode(bytes, { stream: true });
      if (decoded) {
        terminal.write(decoded);
      }
    },
    resize: async (nextSize) => {
      assertTerminalSize(nextSize);
      terminal.resize(nextSize.columns, nextSize.rows);
    },
    close: async () => terminal.kill(),
    kill: (signal?: string) => terminal.kill(signal),
  };
}

export async function attachLocalStdio(
  terminal: TerminalDuplex,
  options?: AttachLocalStdioOptions,
): Promise<void> {
  if (options?.signal?.aborted) {
    await terminal.close("aborted");
    return;
  }
  const stdin = options?.stdin ?? process.stdin;
  const stdout = options?.stdout ?? process.stdout;
  const output = terminal.output[Symbol.asyncIterator]();
  const aborted = abortPromise(options?.signal);
  const previousRaw = stdin.isTTY ? stdin.isRaw : false;
  const writeInput = (data: Buffer | string) => {
    const bytes = typeof data === "string" ? textEncoder.encode(data) : data;
    const write = terminal.write?.(bytes);
    void write?.catch(() => undefined);
  };
  const resize = () => {
    const size = terminalSize(stdout);
    void terminal.resize?.(size);
    options?.onResize?.(size);
  };
  const abort = () => void terminal.close("aborted").catch(() => undefined);

  if (stdin.isTTY) {
    stdin.setRawMode(true);
    stdin.resume();
  }
  stdin.on("data", writeInput);
  stdout.on("resize", resize);
  options?.signal?.addEventListener("abort", abort, { once: true });
  resize();

  let outputCompleted = false;
  try {
    for (;;) {
      const next = aborted
        ? await Promise.race([output.next(), aborted.promise])
        : await output.next();
      if (next === abortedResult || next.done) {
        outputCompleted = next !== abortedResult;
        break;
      }
      await writeToStream(stdout, next.value);
    }
  } finally {
    aborted?.dispose();
    if (!outputCompleted) {
      const returned = output.return?.();
      if (options?.signal?.aborted) {
        void returned;
      } else {
        await returned;
      }
    }
    stdin.off("data", writeInput);
    stdout.off("resize", resize);
    options?.signal?.removeEventListener("abort", abort);
    if (stdin.isTTY) {
      stdin.setRawMode(previousRaw);
    }
  }
}

export async function ensureNodePtySpawnHelperExecutable(): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  let packageRoot: string;
  try {
    packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.resolve("node-pty"))));
  } catch {
    return;
  }
  for (const candidate of [
    path.join(packageRoot, "build", "Release", "spawn-helper"),
    path.join(packageRoot, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
  ]) {
    try {
      await fs.chmod(candidate, 0o755);
      return;
    } catch {
      // Layouts differ between node-pty releases and platforms.
    }
  }
}

export async function readGhosttyAsset(pathname: string): Promise<GhosttyAsset | null> {
  const asset = ghosttyAssets().get(pathname);
  if (!asset) {
    return null;
  }
  return {
    body: await fs.readFile(asset.path),
    contentType: asset.contentType,
  };
}

class AsyncByteQueue implements AsyncIterableIterator<Uint8Array> {
  private readonly maxBytes: number;
  private readonly onDrop?: (droppedBytes: number) => void;
  private chunks: Uint8Array[] = [];
  private bytes = 0;
  private waiters: Array<(result: IteratorResult<Uint8Array>) => void> = [];
  private closed = false;

  constructor(maxBytes = 1024 * 1024, onDrop?: (droppedBytes: number) => void) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new RangeError("outputBufferBytes must be a positive safe integer");
    }
    this.maxBytes = maxBytes;
    this.onDrop = onDrop;
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> {
    return this;
  }

  push(bytes: Uint8Array): void {
    if (this.closed) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value: bytes.slice() });
      return;
    }
    const chunk =
      bytes.byteLength > this.maxBytes
        ? bytes.slice(bytes.byteLength - this.maxBytes)
        : bytes.slice();
    let droppedBytes = bytes.byteLength - chunk.byteLength;
    while (this.chunks.length > 0 && this.bytes + chunk.byteLength > this.maxBytes) {
      const removed = this.chunks.shift();
      const removedBytes = removed?.byteLength ?? 0;
      this.bytes -= removedBytes;
      droppedBytes += removedBytes;
    }
    this.chunks.push(chunk);
    this.bytes += chunk.byteLength;
    if (droppedBytes > 0) {
      this.onDrop?.(droppedBytes);
    }
  }

  async next(): Promise<IteratorResult<Uint8Array>> {
    const chunk = this.chunks.shift();
    if (chunk) {
      this.bytes -= chunk.byteLength;
      return { done: false, value: chunk };
    }
    if (this.closed) {
      return { done: true, value: undefined };
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }
}

function currentEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function terminalSize(stdout: NodeJS.WriteStream): TerminalSize {
  return assertTerminalSize({
    columns: Math.max(20, stdout.columns || 120),
    rows: Math.max(10, stdout.rows || 34),
  });
}

function writeToStream(stream: NodeJS.WriteStream, bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(bytes, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function ghosttyAssets(): Map<string, { path: string; contentType: string }> {
  const modulePath = fileURLToPath(import.meta.resolve("ghostty-web"));
  const distPath = path.dirname(modulePath);
  return new Map([
    ["/vendor/ghostty-web.js", { path: modulePath, contentType: "text/javascript; charset=utf-8" }],
    [
      "/vendor/ghostty-vt.wasm",
      {
        path: fileURLToPath(import.meta.resolve("ghostty-web/ghostty-vt.wasm")),
        contentType: "application/wasm",
      },
    ],
    [
      "/vendor/__vite-browser-external-2447137e.js",
      {
        path: path.join(distPath, "__vite-browser-external-2447137e.js"),
        contentType: "text/javascript; charset=utf-8",
      },
    ],
  ]);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("The operation was aborted");
  }
}

const abortedResult = Symbol("aborted");

function abortPromise(
  signal?: AbortSignal,
): { promise: Promise<typeof abortedResult>; dispose(): void } | undefined {
  if (!signal) {
    return undefined;
  }
  if (signal.aborted) {
    return { promise: Promise.resolve(abortedResult), dispose: () => undefined };
  }
  let resolveAbort: (value: typeof abortedResult) => void = noop;
  const promise = new Promise<typeof abortedResult>((resolve) => {
    resolveAbort = resolve;
  });
  const abort = () => resolveAbort(abortedResult);
  signal.addEventListener("abort", abort, { once: true });
  return { promise, dispose: () => signal.removeEventListener("abort", abort) };
}

function noop(): void {}
