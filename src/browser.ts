import type {
  FitAddon as GhosttyFitAddon,
  Ghostty,
  IDisposable,
  ITerminalOptions,
  Terminal,
} from "ghostty-web";
import { assertTerminalSize, LibterminalError, type TerminalSize } from "./index.js";
import {
  TerminalMessageType,
  encodeTerminalFrame,
  tryDecodeTerminalFrame,
  type TerminalFrame,
  type TerminalFrameLimits,
  type TerminalMessageType as TerminalFrameMessageType,
} from "./protocol.js";

export {
  createTerminalDefaultColorQueryResponder,
  type TerminalDefaultColorQueryResponder,
  type TerminalDefaultColorQueryResponderOptions,
  type TerminalDefaultColors,
} from "./browser-color-query.js";

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

export type TerminalHubWebSocket = {
  readonly readyState: number;
  binaryType?: string;
  send(data: string | ArrayBuffer | ArrayBufferView | Blob): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(
    type: "close",
    listener: (event: { code?: number; reason?: string }) => void,
  ): void;
  addEventListener(type: "error", listener: () => void): void;
  removeEventListener(type: "open", listener: () => void): void;
  removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener(
    type: "close",
    listener: (event: { code?: number; reason?: string }) => void,
  ): void;
  removeEventListener(type: "error", listener: () => void): void;
};

export type TerminalHubClientOptions = {
  url: string | (() => string);
  frameLimits?: TerminalFrameLimits;
  reconnectDelayMs?: number;
  shouldReconnect?: () => boolean;
  socketFactory?: (url: string) => TerminalHubWebSocket;
  onOpen?: () => void;
  onFrame?: (frame: TerminalFrame) => void;
  onClose?: (event: { code?: number; reason?: string }) => void;
  onError?: (error?: unknown) => void;
};

const textEncoder = new TextEncoder();
const runtimeCache = new Map<string, Promise<GhosttyRuntime>>();
const WEB_SOCKET_CLOSING = 2;
const WEB_SOCKET_OPEN = 1;

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
    if (isAbortReason(options.signal, cause)) {
      throw cause;
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
  let completed = false;
  let failed = false;
  let failure: unknown;
  try {
    for (;;) {
      const result = aborted
        ? await Promise.race([iterator.next(), aborted.promise])
        : await iterator.next();
      if (result === abortedResult || result.done) {
        completed = result !== abortedResult;
        return;
      }
      target.write(result.value);
    }
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    aborted?.dispose();
    if (!completed) {
      const returned = iterator.return?.();
      if (signal?.aborted) {
        void Promise.resolve(returned).catch(noop);
      } else {
        try {
          await returned;
        } catch (error) {
          if (!failed) {
            failed = true;
            failure = error;
          }
        }
      }
    }
  }
  if (failed) {
    throw failure;
  }
}

export class TerminalHubClient {
  private readonly options: TerminalHubClientOptions;
  private socket: TerminalHubWebSocket | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private closedByCaller = false;

  constructor(options: TerminalHubClientOptions) {
    this.options = options;
  }

  get isOpen(): boolean {
    return this.socket?.readyState === WEB_SOCKET_OPEN;
  }

  connect(): void {
    this.closedByCaller = false;
    if (this.socket && this.socket.readyState < WEB_SOCKET_CLOSING) {
      return;
    }
    this.clearReconnectTimer();
    let socket: TerminalHubWebSocket;
    try {
      socket = (this.options.socketFactory ?? defaultTerminalHubSocketFactory)(this.resolveUrl());
    } catch (error) {
      this.reportError(error);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    let messageQueue = Promise.resolve();
    const enqueueMessage = (task: () => Promise<void>) => {
      messageQueue = messageQueue
        .catch(noop)
        .then(task)
        .catch((error: unknown) => this.reportError(error));
    };
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", this.handleOpen(socket));
    socket.addEventListener("message", this.handleMessage(socket, enqueueMessage));
    socket.addEventListener("close", this.handleClose(socket));
    socket.addEventListener("error", this.handleError(socket));
  }

  send(params: {
    type: TerminalFrameMessageType;
    sessionId?: string;
    payload?: Uint8Array;
  }): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== WEB_SOCKET_OPEN) {
      return false;
    }
    try {
      socket.send(encodeTerminalFrame(params, this.options.frameLimits));
      return true;
    } catch (error) {
      this.reportError(error);
      return false;
    }
  }

  close(code = 1000, reason = "terminal hub closed"): void {
    this.closedByCaller = true;
    this.clearReconnectTimer();
    const socket = this.socket;
    if (!socket || socket.readyState >= WEB_SOCKET_CLOSING) {
      return;
    }
    try {
      socket.close(code, reason);
    } catch (error) {
      this.socket = undefined;
      this.reportError(error);
    }
  }

  private handleOpen(socket: TerminalHubWebSocket): () => void {
    return () => {
      if (this.socket !== socket) {
        return;
      }
      this.send({ type: TerminalMessageType.Hello });
      this.notify(() => this.options.onOpen?.());
    };
  }

  private handleMessage(
    socket: TerminalHubWebSocket,
    enqueueMessage: (task: () => Promise<void>) => void,
  ): (event: { data: unknown }) => void {
    return (event) => {
      enqueueMessage(async () => {
        if (this.socket !== socket) {
          return;
        }
        const frame = tryDecodeTerminalFrame(
          await terminalFrameBytes(event.data),
          this.options.frameLimits,
        );
        if (frame && this.socket === socket) {
          this.notify(() => this.options.onFrame?.(frame));
        }
      });
    };
  }

  private handleClose(
    socket: TerminalHubWebSocket,
  ): (event: { code?: number; reason?: string }) => void {
    return (event) => {
      if (this.socket !== socket) {
        return;
      }
      this.socket = undefined;
      this.notify(() => this.options.onClose?.(event));
      this.scheduleReconnect();
    };
  }

  private handleError(socket: TerminalHubWebSocket): () => void {
    return () => {
      if (this.socket === socket) {
        this.reportError();
      }
    };
  }

  private resolveUrl(): string {
    return typeof this.options.url === "function" ? this.options.url() : this.options.url;
  }

  private scheduleReconnect(): void {
    if (this.closedByCaller || this.reconnectTimer || !this.shouldReconnect()) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, this.options.reconnectDelayMs ?? 1500);
  }

  private shouldReconnect(): boolean {
    try {
      return Boolean(this.options.shouldReconnect?.());
    } catch (error) {
      this.reportError(error);
      return false;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private notify(callback: () => void): void {
    try {
      callback();
    } catch (error) {
      this.reportError(error);
    }
  }

  private reportError(error?: unknown): void {
    try {
      this.options.onError?.(error);
    } catch {
      // Product error callbacks must not interrupt terminal transport cleanup.
    }
  }
}

class BrowserTerminalController implements GhosttyTerminalController {
  readonly terminal: Terminal;
  private readonly fitAddon: GhosttyFitAddon;
  private readonly options: CreateGhosttyTerminalOptions;
  private inputSubscription?: IDisposable;
  private resizeSubscription?: IDisposable;
  private abortListener?: () => void;
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
    const signal = this.options.signal;
    if (signal) {
      this.abortListener = () => this.dispose();
      signal.addEventListener("abort", this.abortListener, { once: true });
      if (signal.aborted) {
        this.abortListener();
      }
    }
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
    if (this.abortListener) {
      this.options.signal?.removeEventListener("abort", this.abortListener);
      this.abortListener = undefined;
    }
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

function defaultTerminalHubSocketFactory(url: string): TerminalHubWebSocket {
  return new WebSocket(url);
}

async function terminalFrameBytes(data: unknown): Promise<Uint8Array> {
  if (data instanceof Uint8Array) {
    return data.slice();
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }
  if (hasArrayBuffer(data)) {
    return new Uint8Array(await data.arrayBuffer());
  }
  return textEncoder.encode(String(data));
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

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
  }
}

function isAbortReason(signal: AbortSignal | undefined, cause: unknown): boolean {
  if (!signal?.aborted) {
    return false;
  }
  if (cause === signal.reason) {
    return true;
  }
  return (
    signal.reason === undefined && cause instanceof DOMException && cause.name === "AbortError"
  );
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

function noop(): void {}

function hasArrayBuffer(value: unknown): value is { arrayBuffer(): Promise<ArrayBuffer> } {
  return (
    value !== null &&
    typeof value === "object" &&
    "arrayBuffer" in value &&
    typeof value.arrayBuffer === "function"
  );
}
