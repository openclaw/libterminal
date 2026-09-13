import { describe, expect, it, vi } from "vitest";
import { BatchPublisher, BoundedReplayBuffer, TerminalFanout } from "../src/stream.js";
import { terminalBytes as bytes, terminalText as text } from "../src/testing.js";

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
  it("does not let an old handle close a replacement with the same id", async () => {
    const fanout = new TerminalFanout();
    const old = fanout.subscribe("viewer");
    old.close();
    const replacement = fanout.subscribe("viewer");

    old.close();
    expect(fanout.subscriberCount).toBe(1);
    fanout.publish(bytes("live"));
    expect((await replacement[Symbol.asyncIterator]().next()).value).toEqual(bytes("live"));
    replacement.close();
    expect(fanout.subscriberCount).toBe(0);
  });

  it("preserves a replacement created by the overflow callback", () => {
    const fanout = new TerminalFanout({
      replayBytes: 0,
      subscriberBufferBytes: 4,
      onEvent: (event) => {
        if (event.type === "subscriber-overflow") {
          old.close();
          fanout.subscribe("viewer");
        }
      },
    });
    const old = fanout.subscribe("viewer");
    fanout.publish(bytes("1234"));
    fanout.publish(bytes("5"));

    expect(fanout.subscriberCount).toBe(1);
    fanout.close();
  });

  it("does not publish an oversized chunk to reentrant replacements", async () => {
    let overflows = 0;
    const fanout = new TerminalFanout({
      replayBytes: 0,
      subscriberBufferBytes: 4,
      onEvent: (event) => {
        if (event.type === "subscriber-overflow") {
          expect(++overflows).toBe(1);
          subscription.close();
          subscription = fanout.subscribe("viewer", { replay: false });
        }
      },
    });
    let subscription = fanout.subscribe("viewer");

    fanout.publish(bytes("12345"));
    expect(overflows).toBe(1);
    expect(fanout.subscriberCount).toBe(1);
    fanout.publish(bytes("ok"));
    expect((await subscription[Symbol.asyncIterator]().next()).value).toEqual(bytes("ok"));
    fanout.close();
  });

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

  it("stops buffering after the sink fails", async () => {
    const errors: unknown[] = [];
    let rejectSink!: (error: unknown) => void;
    const publisher = new BatchPublisher(
      () =>
        new Promise<void>((_, reject) => {
          rejectSink = reject;
        }),
      {
        maxBatchBytes: 8,
        flushIntervalMs: 10_000,
        onError: (error) => {
          errors.push(error);
        },
      },
    );

    publisher.write(bytes("12345678"));
    await vi.waitFor(() => expect(typeof rejectSink).toBe("function"));
    publisher.write(bytes("hold"));
    const sinkError = new Error("sink closed");
    rejectSink(sinkError);
    await vi.waitFor(() => expect(errors).toEqual([sinkError]));

    for (let index = 0; index < 100; index += 1) {
      publisher.write(bytes("xxxxxxxx"));
    }
    await Promise.resolve();

    const state = publisher as unknown as { bytes: number; chunks: Uint8Array[] };
    expect(state.chunks).toEqual([]);
    expect(state.bytes).toBe(0);
    expect(errors).toEqual([sinkError]);
    await expect(publisher.flush()).rejects.toBe(sinkError);
  });
});
