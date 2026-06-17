import type {
  FitAddon as GhosttyFitAddon,
  Ghostty,
  IDisposable,
  ITerminalOptions,
  Terminal,
} from "ghostty-web";
import { assertTerminalSize, LibterminalError, type TerminalSize } from "./index.js";

export type GhosttyRuntime = {
  ghostty: Ghostty;
  Terminal: typeof import("ghostty-web").Terminal;
  FitAddon: typeof import("ghostty-web").FitAddon;
};

export type GhosttyRuntimeOptions = {
  wasmUrl?: string;
  module?: typeof import("ghostty-web");
};

export type GhosttyTerminalStatus =
  | { state: "loading" }
  | { state: "ready" }
  | { state: "ended" }
  | { state: "error"; error: unknown };

export type CreateGhosttyTerminalOptions = {
  parent: HTMLElement;
  runtime?: GhosttyRuntime;
  runtimeOptions?: GhosttyRuntimeOptions;
  terminalOptions?: Omit<ITerminalOptions, "disableStdin" | "ghostty">;
  size?: TerminalSize;
  readOnly?: boolean;
  autoFit?: boolean;
  signal?: AbortSignal;
  onData?: (bytes: Uint8Array) => void;
  onResize?: (size: TerminalSize) => void;
  onStatus?: (status: GhosttyTerminalStatus) => void;
};

export type GhosttyTerminalController = {
  readonly terminal: Terminal;
  readonly readOnly: boolean;
  write(bytes: Uint8Array): void;
  resize(size: TerminalSize): void;
  fit(): void;
  setReadOnly(readOnly: boolean): void;
  attach(source: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<void>;
  dispose(): void;
};

const textEncoder = new TextEncoder();
const runtimeCache = new Map<string, Promise<GhosttyRuntime>>();

export async function loadGhosttyRuntime(options?: GhosttyRuntimeOptions): Promise<GhosttyRuntime> {
  if (options?.module) {
    return loadRuntimeFromModule(options.module, options.wasmUrl);
  }
  const cacheKey = options?.wasmUrl ?? "<default>";
  let runtime = runtimeCache.get(cacheKey);
  if (!runtime) {
    runtime = import("ghostty-web").then((module) =>
      loadRuntimeFromModule(module, options?.wasmUrl),
    );
    runtimeCache.set(cacheKey, runtime);
  }
  try {
    return await runtime;
  } catch (cause) {
    runtimeCache.delete(cacheKey);
    throw new LibterminalError("ghostty_unavailable", "failed to load Ghostty browser runtime", {
      cause,
    });
  }
}

export async function createGhosttyTerminal(
  options: CreateGhosttyTerminalOptions,
): Promise<GhosttyTerminalController> {
  options.onStatus?.({ state: "loading" });
  throwIfAborted(options.signal);
  let terminal: Terminal | undefined;
  let controller: BrowserTerminalController | undefined;
  try {
    const runtime = options.runtime ?? (await loadGhosttyRuntime(options.runtimeOptions));
    throwIfAborted(options.signal);
    const readOnly = options.readOnly ?? true;
    terminal = new runtime.Terminal({
      ...options.terminalOptions,
      disableStdin: readOnly,
      ghostty: runtime.ghostty,
    });
    const fitAddon = new runtime.FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(options.parent);
    controller = new BrowserTerminalController(terminal, fitAddon, readOnly, options);
    controller.start();
    options.onStatus?.({ state: "ready" });
    return controller;
  } catch (cause) {
    if (controller) {
      controller.dispose();
    } else {
      terminal?.dispose();
    }
    options.onStatus?.({ state: "error", error: cause });
    if (cause instanceof LibterminalError) {
      throw cause;
    }
    throw new LibterminalError("ghostty_unavailable", "failed to create Ghostty browser terminal", {
      cause,
    });
  }
}

export async function attachTerminalStream(
  target: Pick<Terminal, "write">,
  source: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): Promise<void> {
  const iterator = source[Symbol.asyncIterator]();
  const aborted = abortPromise(signal);
  try {
    for (;;) {
      const result = aborted
        ? await Promise.race([iterator.next(), aborted])
        : await iterator.next();
      if (result === abortedResult || result.done) {
        return;
      }
      target.write(result.value);
    }
  } finally {
    if (signal?.aborted) {
      void iterator.return?.();
    }
  }
}

class BrowserTerminalController implements GhosttyTerminalController {
  readonly terminal: Terminal;
  private readonly fitAddon: GhosttyFitAddon;
  private readonly options: CreateGhosttyTerminalOptions;
  private inputSubscription?: IDisposable;
  private resizeSubscription?: IDisposable;
  private disposed = false;
  private currentReadOnly: boolean;
  private readonly disposeController = new AbortController();

  constructor(
    terminal: Terminal,
    fitAddon: GhosttyFitAddon,
    readOnly: boolean,
    options: CreateGhosttyTerminalOptions,
  ) {
    this.terminal = terminal;
    this.fitAddon = fitAddon;
    this.currentReadOnly = readOnly;
    this.options = options;
  }

  get readOnly(): boolean {
    return this.currentReadOnly;
  }

  start(): void {
    this.inputSubscription = this.terminal.onData((data) => {
      if (!this.currentReadOnly) {
        this.options.onData?.(textEncoder.encode(data));
      }
    });
    this.resizeSubscription = this.terminal.onResize(({ cols, rows }) => {
      this.options.onResize?.({ columns: cols, rows });
    });
    if (this.options.size) {
      this.resize(this.options.size);
    } else if (this.options.autoFit !== false) {
      this.fitAddon.fit();
    }
    if (this.options.autoFit !== false) {
      this.fitAddon.observeResize();
    }
    this.options.signal?.addEventListener("abort", () => this.dispose(), { once: true });
  }

  write(bytes: Uint8Array): void {
    this.assertOpen();
    this.terminal.write(bytes);
  }

  resize(size: TerminalSize): void {
    this.assertOpen();
    assertTerminalSize(size);
    this.terminal.resize(size.columns, size.rows);
  }

  fit(): void {
    this.assertOpen();
    this.fitAddon.fit();
  }

  setReadOnly(readOnly: boolean): void {
    this.assertOpen();
    this.currentReadOnly = readOnly;
    this.terminal.options.disableStdin = readOnly;
  }

  async attach(source: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<void> {
    this.assertOpen();
    const combined = combineAbortSignals(
      this.disposeController.signal,
      signal ?? this.options.signal,
    );
    try {
      await attachTerminalStream(this.terminal, source, combined.signal);
      this.options.onStatus?.({ state: "ended" });
    } catch (error) {
      this.options.onStatus?.({ state: "error", error });
      throw error;
    } finally {
      combined.dispose();
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.disposeController.abort("terminal disposed");
    this.inputSubscription?.dispose();
    this.resizeSubscription?.dispose();
    this.fitAddon.dispose();
    this.terminal.dispose();
  }

  private assertOpen(): void {
    if (this.disposed) {
      throw new LibterminalError("transport_closed", "Ghostty browser terminal is disposed");
    }
  }
}

async function loadRuntimeFromModule(
  module: typeof import("ghostty-web"),
  wasmUrl?: string,
): Promise<GhosttyRuntime> {
  try {
    const ghostty = await module.Ghostty.load(wasmUrl);
    return { ghostty, Terminal: module.Terminal, FitAddon: module.FitAddon };
  } catch (cause) {
    throw new LibterminalError("ghostty_unavailable", "failed to load Ghostty WASM", { cause });
  }
}

const abortedResult = Symbol("aborted");

function abortPromise(signal?: AbortSignal): Promise<typeof abortedResult> | undefined {
  if (!signal) {
    return undefined;
  }
  if (signal.aborted) {
    return Promise.resolve(abortedResult);
  }
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(abortedResult), { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
  }
}

function combineAbortSignals(
  first: AbortSignal,
  second?: AbortSignal,
): { signal: AbortSignal; dispose(): void } {
  if (!second) {
    return { signal: first, dispose: () => undefined };
  }
  const controller = new AbortController();
  const abortFirst = () => controller.abort(first.reason);
  const abortSecond = () => controller.abort(second.reason);
  if (first.aborted) {
    abortFirst();
  } else if (second.aborted) {
    abortSecond();
  } else {
    first.addEventListener("abort", abortFirst, { once: true });
    second.addEventListener("abort", abortSecond, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      first.removeEventListener("abort", abortFirst);
      second.removeEventListener("abort", abortSecond);
    },
  };
}
