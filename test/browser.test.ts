import { describe, expect, it } from "vitest";
import { attachTerminalStream } from "../src/browser.js";

describe("attachTerminalStream", () => {
  it("writes terminal byte chunks in order", async () => {
    const writes: string[] = [];
    await attachTerminalStream(
      {
        write: (chunk: string | Uint8Array) => {
          writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
        },
      },
      chunks("one", "two"),
    );
    expect(writes).toEqual(["one", "two"]);
  });

  it("stops waiting when aborted", async () => {
    const controller = new AbortController();
    const attached = attachTerminalStream({ write: () => undefined }, never(), controller.signal);
    controller.abort();
    await expect(attached).resolves.toBeUndefined();
  });
});

async function* chunks(...values: string[]): AsyncIterable<Uint8Array> {
  for (const value of values) {
    yield new TextEncoder().encode(value);
  }
}

function never(): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
    }),
  };
}
