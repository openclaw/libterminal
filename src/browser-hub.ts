import {
  TerminalMessageType,
  encodeTerminalFrame,
  tryDecodeTerminalFrame,
  type TerminalFrame,
  type TerminalFrameLimits,
  type TerminalMessageType as TerminalFrameMessageType,
} from "./protocol.js";
import { safeClose } from "./websocket-close.js";

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
const WEB_SOCKET_CLOSING = 2;
const WEB_SOCKET_OPEN = 1;

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
    safeClose(socket, code, reason, (error) => this.reportError(error));
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

function hasArrayBuffer(value: unknown): value is { arrayBuffer(): Promise<ArrayBuffer> } {
  return (
    value !== null &&
    typeof value === "object" &&
    "arrayBuffer" in value &&
    typeof value.arrayBuffer === "function"
  );
}

function noop(): void {}
