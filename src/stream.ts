import { LibterminalError } from "./index.js";

export type SlowSubscriberPolicy = "disconnect" | "drop-oldest";

export type FanoutEvent =
  | {
      type: "subscriber-overflow";
      subscriberId: string;
      droppedBytes: number;
      policy: SlowSubscriberPolicy;
    }
  | {
      type: "subscriber-closed";
      subscriberId: string;
      reason?: string;
    };

export type TerminalSubscription = AsyncIterable<Uint8Array> & {
  readonly id: string;
  close(reason?: string): void;
};

export class BoundedReplayBuffer {
  readonly maxBytes: number;
  private chunks: Uint8Array[] = [];
  private storedBytes = 0;

  constructor(maxBytes = 512 * 1024) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new RangeError("maxBytes must be a non-negative safe integer");
    }
    this.maxBytes = maxBytes;
  }

  get byteLength(): number {
    return this.storedBytes;
  }

  append(bytes: Uint8Array): void {
    if (bytes.byteLength === 0 || this.maxBytes === 0) {
      return;
    }
    const chunk =
      bytes.byteLength > this.maxBytes
        ? bytes.slice(bytes.byteLength - this.maxBytes)
        : bytes.slice();
    this.chunks.push(chunk);
    this.storedBytes += chunk.byteLength;
    this.trim();
  }

  snapshot(): Uint8Array[] {
    return this.chunks.map((chunk) => chunk.slice());
  }

  clear(): void {
    this.chunks = [];
    this.storedBytes = 0;
  }

  private trim(): void {
    if (this.storedBytes > this.maxBytes) {
      const chunk = this.chunks[0];
      if (!chunk) {
        return;
      }
      const excess = this.storedBytes - this.maxBytes;
      const trimmed = chunk.slice(Math.min(excess, chunk.byteLength));
      this.chunks[0] = trimmed;
      this.storedBytes -= chunk.byteLength - trimmed.byteLength;
      if (trimmed.byteLength === 0) {
        this.chunks.shift();
        this.trim();
      }
    }
  }
}

export type TerminalFanoutOptions = {
  replayBytes?: number;
  subscriberBufferBytes?: number;
  slowSubscriberPolicy?: SlowSubscriberPolicy;
  onEvent?: (event: FanoutEvent) => void;
};

export class TerminalFanout {
  private readonly replay: BoundedReplayBuffer;
  private readonly subscriberBufferBytes: number;
  private readonly slowSubscriberPolicy: SlowSubscriberPolicy;
  private readonly onEvent?: (event: FanoutEvent) => void;
  private readonly subscribers = new Map<string, SubscriberQueue>();
  private closed = false;

  constructor(options?: TerminalFanoutOptions) {
    this.replay = new BoundedReplayBuffer(options?.replayBytes);
    this.subscriberBufferBytes = options?.subscriberBufferBytes ?? 1024 * 1024;
    if (!Number.isSafeInteger(this.subscriberBufferBytes) || this.subscriberBufferBytes < 1) {
      throw new RangeError("subscriberBufferBytes must be a positive safe integer");
    }
    this.slowSubscriberPolicy = options?.slowSubscriberPolicy ?? "disconnect";
    this.onEvent = options?.onEvent;
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  publish(bytes: Uint8Array): void {
    if (this.closed || bytes.byteLength === 0) {
      return;
    }
    this.replay.append(bytes);
    for (const [subscriberId, subscriber] of this.subscribers) {
      const droppedBytes = subscriber.enqueue(bytes, this.slowSubscriberPolicy);
      if (droppedBytes === 0) {
        continue;
      }
      this.onEvent?.({
        type: "subscriber-overflow",
        subscriberId,
        droppedBytes,
        policy: this.slowSubscriberPolicy,
      });
      if (this.slowSubscriberPolicy === "disconnect") {
        this.removeSubscriber(subscriberId, "subscriber buffer overflow");
      }
    }
  }

  subscribe(id: string, options?: { replay?: boolean }): TerminalSubscription {
    if (this.closed) {
      throw new LibterminalError("transport_closed", "terminal fanout is closed");
    }
    if (this.subscribers.has(id)) {
      throw new Error(`terminal subscriber ${id} already exists`);
    }
    const subscriber = new SubscriberQueue(this.subscriberBufferBytes);
    this.subscribers.set(id, subscriber);
    if (options?.replay !== false) {
      for (const chunk of this.replay.snapshot()) {
        subscriber.enqueue(chunk, "drop-oldest");
      }
    }

    return {
      id,
      [Symbol.asyncIterator]: () => subscriber,
      close: (reason?: string) => this.removeSubscriber(id, reason),
    };
  }

  close(reason?: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const subscriberId of this.subscribers.keys()) {
      this.removeSubscriber(subscriberId, reason);
    }
    this.replay.clear();
  }

  private removeSubscriber(id: string, reason?: string): void {
    const subscriber = this.subscribers.get(id);
    if (!subscriber) {
      return;
    }
    this.subscribers.delete(id);
    subscriber.close();
    this.onEvent?.({ type: "subscriber-closed", subscriberId: id, reason });
  }
}

export type BatchPublisherOptions = {
  maxBatchBytes?: number;
  flushIntervalMs?: number;
  signal?: AbortSignal;
  onError?: (error: unknown) => void;
};

export class BatchPublisher {
  private readonly sink: (bytes: Uint8Array) => Promise<void>;
  private readonly maxBatchBytes: number;
  private readonly flushIntervalMs: number;
  private readonly onError?: (error: unknown) => void;
  private chunks: Uint8Array[] = [];
  private bytes = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: Promise<void> = Promise.resolve();
  private failure: unknown;
  private stopped = false;
  private abortSignal?: AbortSignal;
  private abortHandler?: () => void;

  constructor(sink: (bytes: Uint8Array) => Promise<void>, options?: BatchPublisherOptions) {
    this.sink = sink;
    this.maxBatchBytes = options?.maxBatchBytes ?? 64 * 1024;
    this.flushIntervalMs = options?.flushIntervalMs ?? 40;
    this.onError = options?.onError;
    if (!Number.isSafeInteger(this.maxBatchBytes) || this.maxBatchBytes < 1) {
      throw new RangeError("maxBatchBytes must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.flushIntervalMs) || this.flushIntervalMs < 0) {
      throw new RangeError("flushIntervalMs must be a non-negative safe integer");
    }
    if (options?.signal?.aborted) {
      this.stopped = true;
      return;
    }
    this.abortSignal = options?.signal;
    this.abortHandler = () => void this.stop().catch((error: unknown) => this.onError?.(error));
    this.abortSignal?.addEventListener("abort", this.abortHandler, { once: true });
  }

  write(bytes: Uint8Array): void {
    if (this.stopped || bytes.byteLength === 0) {
      return;
    }
    this.chunks.push(bytes.slice());
    this.bytes += bytes.byteLength;
    if (this.bytes >= this.maxBatchBytes) {
      void this.flush().catch((error: unknown) => this.onError?.(error));
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => {
        void this.flush().catch((error: unknown) => this.onError?.(error));
      }, this.flushIntervalMs);
    }
  }

  async flush(): Promise<void> {
    this.clearTimer();
    if (this.failure) {
      throw this.failure;
    }
    if (this.chunks.length === 0) {
      await this.pending;
      return;
    }

    const batch = concatenate(this.chunks, this.bytes);
    this.chunks = [];
    this.bytes = 0;
    this.pending = this.pending
      .then(() => this.sink(batch))
      .catch((error: unknown) => {
        this.failure = error;
        throw error;
      });
    await this.pending;
  }

  async stop(): Promise<void> {
    this.detachAbort();
    if (this.stopped) {
      await this.pending;
      return;
    }
    this.stopped = true;
    await this.flush();
  }

  private clearTimer(): void {
    if (!this.timer) {
      return;
    }
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private detachAbort(): void {
    if (this.abortSignal && this.abortHandler) {
      this.abortSignal.removeEventListener("abort", this.abortHandler);
    }
    this.abortSignal = undefined;
    this.abortHandler = undefined;
  }
}

class SubscriberQueue implements AsyncIterator<Uint8Array> {
  private readonly maxBytes: number;
  private chunks: Uint8Array[] = [];
  private bytes = 0;
  private waiters: Array<(result: IteratorResult<Uint8Array>) => void> = [];
  private closed = false;

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  enqueue(bytes: Uint8Array, policy: SlowSubscriberPolicy): number {
    if (this.closed || bytes.byteLength === 0) {
      return 0;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value: bytes.slice() });
      return 0;
    }
    if (this.bytes + bytes.byteLength <= this.maxBytes) {
      this.chunks.push(bytes.slice());
      this.bytes += bytes.byteLength;
      return 0;
    }
    if (policy === "disconnect") {
      return bytes.byteLength;
    }

    let droppedBytes = 0;
    while (this.chunks.length > 0 && this.bytes + bytes.byteLength > this.maxBytes) {
      const removed = this.chunks.shift();
      const removedBytes = removed?.byteLength ?? 0;
      this.bytes -= removedBytes;
      droppedBytes += removedBytes;
    }
    const chunk =
      bytes.byteLength > this.maxBytes
        ? bytes.slice(bytes.byteLength - this.maxBytes)
        : bytes.slice();
    this.chunks.push(chunk);
    this.bytes += chunk.byteLength;
    return droppedBytes + Math.max(0, bytes.byteLength - chunk.byteLength);
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

function concatenate(chunks: Uint8Array[], byteLength: number): Uint8Array {
  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
