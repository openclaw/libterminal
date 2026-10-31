import { AsyncByteQueue } from "./byte-queue.js";
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
    // Buffer.slice() aliases its source; always take ownership of retained bytes.
    const chunk = new Uint8Array(
      bytes.byteLength > this.maxBytes ? bytes.subarray(bytes.byteLength - this.maxBytes) : bytes,
    );
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
    let removedChunks = 0;
    while (this.storedBytes > this.maxBytes) {
      const chunk = this.chunks[removedChunks];
      const excess = this.storedBytes - this.maxBytes;
      if (excess >= chunk.byteLength) {
        removedChunks += 1;
        this.storedBytes -= chunk.byteLength;
      } else {
        this.chunks[removedChunks] = chunk.slice(excess);
        this.storedBytes -= excess;
      }
    }
    if (removedChunks > 0) {
      this.chunks.splice(0, removedChunks);
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
  private readonly subscribers = new Map<string, AsyncByteQueue>();
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
    // Callbacks can replace subscribers during publication.
    const subscribers = [...this.subscribers];
    for (const [subscriberId, subscriber] of subscribers) {
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
        this.removeSubscriber(subscriberId, subscriber, "subscriber buffer overflow");
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
    const subscriber = new AsyncByteQueue(this.subscriberBufferBytes);
    this.subscribers.set(id, subscriber);
    if (options?.replay !== false) {
      for (const chunk of this.replay.snapshot()) {
        subscriber.enqueue(chunk, "drop-oldest");
      }
    }

    return {
      id,
      [Symbol.asyncIterator]: () => subscriber,
      close: (reason?: string) => this.removeSubscriber(id, subscriber, reason),
    };
  }

  close(reason?: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const [subscriberId, subscriber] of this.subscribers) {
      this.removeSubscriber(subscriberId, subscriber, reason);
    }
    this.replay.clear();
  }

  private removeSubscriber(id: string, subscriber: AsyncByteQueue, reason?: string): void {
    if (this.subscribers.get(id) !== subscriber) {
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
  private failureReported = false;
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
    this.abortHandler = () => void this.stop().catch((error: unknown) => this.reportFailure(error));
    this.abortSignal?.addEventListener("abort", this.abortHandler, { once: true });
  }

  write(bytes: Uint8Array): void {
    if (this.stopped || bytes.byteLength === 0) {
      return;
    }
    this.chunks.push(new Uint8Array(bytes));
    this.bytes += bytes.byteLength;
    if (this.bytes >= this.maxBatchBytes) {
      void this.flush().catch((error: unknown) => this.reportFailure(error));
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => {
        void this.flush().catch((error: unknown) => this.reportFailure(error));
      }, this.flushIntervalMs);
    }
  }

  async flush(): Promise<void> {
    this.clearTimer();
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
        this.stopped = true;
        this.dropBufferedChunks();
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

  private reportFailure(error: unknown): void {
    if (this.failureReported) {
      return;
    }
    this.failureReported = true;
    this.onError?.(error);
  }

  private dropBufferedChunks(): void {
    this.chunks = [];
    this.bytes = 0;
    this.clearTimer();
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

function concatenate(chunks: Uint8Array[], byteLength: number): Uint8Array {
  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
