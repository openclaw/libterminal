import { AsyncByteQueue } from "./byte-queue.js";
import type { TerminalDuplex, TerminalSize } from "./index.js";
import {
  WEB_SOCKET_OPEN,
  type WebSocketCloseEventLike,
  type WebSocketLike,
  type WebSocketMessageEventLike,
  type WebSocketPayload,
} from "./worker.js";

export const LIBTERMINAL_EXPORTS = [
  "@openclaw/libterminal",
  "@openclaw/libterminal/protocol",
  "@openclaw/libterminal/stream",
  "@openclaw/libterminal/browser",
  "@openclaw/libterminal/node",
  "@openclaw/libterminal/worker",
  "@openclaw/libterminal/worker-assets",
  "@openclaw/libterminal/testing",
] as const;

export type FakeTerminalDuplex = TerminalDuplex & {
  readonly writes: Uint8Array[];
  readonly sizes: TerminalSize[];
  readonly closeReasons: Array<string | undefined>;
  emitOutput(bytes: Uint8Array): void;
  endOutput(): void;
};

export function createFakeTerminalDuplex(): FakeTerminalDuplex {
  const output = new AsyncByteQueue(Number.POSITIVE_INFINITY);
  const writes: Uint8Array[] = [];
  const sizes: TerminalSize[] = [];
  const closeReasons: Array<string | undefined> = [];
  return {
    output,
    writes,
    sizes,
    closeReasons,
    write: async (bytes) => {
      writes.push(new Uint8Array(bytes));
    },
    resize: async (size) => {
      sizes.push({ ...size });
    },
    close: async (reason) => {
      closeReasons.push(reason);
      output.close();
    },
    emitOutput: (bytes) => {
      output.enqueue(bytes, "drop-oldest");
    },
    endOutput: () => output.close(),
  };
}

type FakeWebSocketListeners = {
  message: (event: WebSocketMessageEventLike) => void;
  close: (event: WebSocketCloseEventLike) => void;
  error: () => void;
};

export class FakeWebSocket implements WebSocketLike {
  readyState = WEB_SOCKET_OPEN;
  readonly sent: WebSocketPayload[] = [];
  closed?: { code?: number; reason?: string };
  private readonly listeners: {
    [Type in keyof FakeWebSocketListeners]: Set<FakeWebSocketListeners[Type]>;
  } = { message: new Set(), close: new Set(), error: new Set() };

  send(data: WebSocketPayload): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.readyState = 3;
  }

  addEventListener<Type extends keyof FakeWebSocketListeners>(
    type: Type,
    listener: FakeWebSocketListeners[Type],
  ): void {
    this.listeners[type].add(listener);
  }

  removeEventListener<Type extends keyof FakeWebSocketListeners>(
    type: Type,
    listener: FakeWebSocketListeners[Type],
  ): void {
    this.listeners[type].delete(listener);
  }

  receive(data: unknown): void {
    for (const listener of this.listeners.message) {
      listener({ data });
    }
  }

  emitClose(code = 1000, reason = ""): void {
    this.readyState = 3;
    for (const listener of this.listeners.close) {
      listener({ code, reason });
    }
  }

  emitError(): void {
    for (const listener of this.listeners.error) {
      listener();
    }
  }
}

export class ManualClock {
  private currentTime = 0;
  private nextId = 1;
  private readonly tasks = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.currentTime;
  }

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.currentTime + Math.max(0, delayMs), callback });
    return id;
  }

  clearTimeout(id: number): void {
    this.tasks.delete(id);
  }

  advanceBy(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      throw new RangeError("durationMs must be a non-negative finite number");
    }
    const target = this.currentTime + durationMs;
    for (;;) {
      const next = this.nextTask(target);
      if (!next) {
        break;
      }
      this.currentTime = next.at;
      this.tasks.delete(next.id);
      next.callback();
    }
    this.currentTime = target;
  }

  private nextTask(target: number): { id: number; at: number; callback: () => void } | undefined {
    let selected: { id: number; at: number; callback: () => void } | undefined;
    for (const [id, task] of this.tasks) {
      if (task.at > target || (selected && selected.at <= task.at)) {
        continue;
      }
      selected = { id, ...task };
    }
    return selected;
  }
}

export function terminalBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function terminalText(chunks: Iterable<Uint8Array>): string {
  const collected = [...chunks];
  const byteLength = collected.reduce((total, chunk) => total + chunk.byteLength, 0);
  const joined = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of collected) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

export async function collectTerminalOutput(
  output: AsyncIterable<Uint8Array>,
  limit = Number.POSITIVE_INFINITY,
): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of output) {
    chunks.push(new Uint8Array(chunk));
    if (chunks.length >= limit) {
      break;
    }
  }
  return chunks;
}
