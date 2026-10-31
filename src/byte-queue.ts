export class AsyncByteQueue implements AsyncIterableIterator<Uint8Array> {
  private readonly maxBytes: number;
  private chunks: Uint8Array[] = [];
  private bytes = 0;
  private waiters: Array<(result: IteratorResult<Uint8Array>) => void> = [];
  private closed = false;

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> {
    return this;
  }

  enqueue(bytes: Uint8Array, policy: "disconnect" | "drop-oldest"): number {
    if (this.closed) {
      return 0;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value: new Uint8Array(bytes) });
      return 0;
    }
    if (policy === "disconnect" && this.bytes + bytes.byteLength > this.maxBytes) {
      return bytes.byteLength;
    }

    let droppedBytes = 0;
    let removedChunks = 0;
    while (removedChunks < this.chunks.length && this.bytes + bytes.byteLength > this.maxBytes) {
      const removedBytes = this.chunks[removedChunks++].byteLength;
      this.bytes -= removedBytes;
      droppedBytes += removedBytes;
    }
    if (removedChunks > 0) {
      this.chunks.splice(0, removedChunks);
    }
    const chunk = new Uint8Array(
      bytes.byteLength > this.maxBytes ? bytes.subarray(bytes.byteLength - this.maxBytes) : bytes,
    );
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
