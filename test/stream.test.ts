import { describe, expect, it, vi } from "vitest";
import { BatchPublisher, BoundedReplayBuffer, TerminalFanout } from "../src/stream.js";

describe("BoundedReplayBuffer", () => {
  it("retains only the newest bounded output", () => {
    const replay = new BoundedReplayBuffer(5);
    replay.append(bytes("abc"));
    replay.append(bytes("def"));
    expect(text(replay.snapshot())).toBe("bcdef");
    replay.append(bytes("123456"));
    expect(text(replay.snapshot())).toBe("23456");
  });

  it("trims fragmented output without recursive stack growth", () => {
    const replay = new BoundedReplayBuffer(20_000);
    for (let index = 0; index < 20_000; index += 1) {
      replay.append(new Uint8Array([index % 256]));
    }

    replay.append(new Uint8Array(20_000).fill(42));
    expect(replay.byteLength).toBe(20_000);
    expect(replay.snapshot()).toHaveLength(1);
    expect(replay.snapshot()[0]).toEqual(new Uint8Array(20_000).fill(42));
  });
});

describe("TerminalFanout", () => {
  it("replays output and fans out new chunks", async () => {
    const fanout = new TerminalFanout({ replayBytes: 8, subscriberBufferBytes: 8 });
    fanout.publish(bytes("before"));
    const subscription = fanout.subscribe("viewer");
    const iterator = subscription[Symbol.asyncIterator]();
    expect(new TextDecoder().decode((await iterator.next()).value)).toBe("before");
    fanout.publish(bytes("after"));
    expect(new TextDecoder().decode((await iterator.next()).value)).toBe("after");
    subscription.close();
    expect((await iterator.next()).done).toBe(true);
  });

  it("disconnects slow subscribers without affecting other subscribers", async () => {
    const events: string[] = [];
    const fanout = new TerminalFanout({
      replayBytes: 0,
      subscriberBufferBytes: 4,
      slowSubscriberPolicy: "disconnect",
      onEvent: (event) => events.push(event.type),
    });
    const slow = fanout.subscribe("slow", { replay: false });
    fanout.publish(bytes("1234"));
    fanout.publish(bytes("5"));
    expect(events).toEqual(["subscriber-overflow", "subscriber-closed"]);
    const iterator = slow[Symbol.asyncIterator]();
    expect(new TextDecoder().decode((await iterator.next()).value)).toBe("1234");
    expect((await iterator.next()).done).toBe(true);
  });
});

describe("BatchPublisher", () => {
  it("publishes ordered batches at the byte threshold and on stop", async () => {
    const batches: string[] = [];
    const publisher = new BatchPublisher(
      async (batch) => {
        batches.push(new TextDecoder().decode(batch));
      },
      { maxBatchBytes: 4, flushIntervalMs: 10_000 },
    );
    publisher.write(bytes("ab"));
    publisher.write(bytes("cd"));
    await vi.waitFor(() => expect(batches).toEqual(["abcd"]));
    publisher.write(bytes("ef"));
    await publisher.stop();
    expect(batches).toEqual(["abcd", "ef"]);
  });

  it("ignores writes when constructed with an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const batches: Uint8Array[] = [];
    const publisher = new BatchPublisher(
      async (batch) => {
        batches.push(batch);
      },
      { signal: controller.signal },
    );
    publisher.write(bytes("ignored"));
    await publisher.stop();
    expect(batches).toEqual([]);
  });
});

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function text(chunks: Uint8Array[]): string {
  return new TextDecoder().decode(
    chunks.reduce((joined, chunk) => {
      const next = new Uint8Array(joined.byteLength + chunk.byteLength);
      next.set(joined);
      next.set(chunk, joined.byteLength);
      return next;
    }, new Uint8Array()),
  );
}
