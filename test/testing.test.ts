import { describe, expect, it } from "vitest";
import {
  collectTerminalOutput,
  createFakeTerminalDuplex,
  ManualClock,
  terminalBytes,
  terminalText,
} from "../src/testing.js";

describe("testing helpers", () => {
  it("records owned copies of Buffer writes", async () => {
    const terminal = createFakeTerminalDuplex();
    const source = Buffer.from("_input_").subarray(1, 6);
    await terminal.write?.(source);
    source.fill(120);
    expect(terminalText(terminal.writes)).toBe("input");
    await terminal.close();
  });

  it.each([false, true])("copies Buffer output with a waiting reader: %s", async (waiting) => {
    const terminal = createFakeTerminalDuplex();
    const iterator = terminal.output[Symbol.asyncIterator]();
    const pending = waiting ? iterator.next() : undefined;
    const source = Buffer.from("_output_").subarray(1, 7);
    terminal.emitOutput(source);
    source.fill(120);
    expect(terminalText([(await (pending ?? iterator.next())).value])).toBe("output");
    await terminal.close();
  });

  it("collects a stable snapshot when a source reuses a Buffer", async () => {
    const buffer = Buffer.from("one");
    async function* source() {
      yield buffer;
      buffer.write("two");
      yield buffer;
    }
    expect(terminalText(await collectTerminalOutput(source()))).toBe("onetwo");
  });

  it("drives a fake terminal duplex", async () => {
    const terminal = createFakeTerminalDuplex();
    terminal.emitOutput(terminalBytes("hello"));
    terminal.endOutput();
    expect(terminalText(await collectTerminalOutput(terminal.output))).toBe("hello");
    await terminal.write?.(terminalBytes("input"));
    await terminal.resize?.({ columns: 80, rows: 24 });
    await terminal.close("done");
    expect(terminalText(terminal.writes)).toBe("input");
    expect(terminal.sizes).toEqual([{ columns: 80, rows: 24 }]);
    expect(terminal.closeReasons).toEqual(["done"]);
  });

  it("runs manual-clock tasks deterministically", () => {
    const clock = new ManualClock();
    const events: string[] = [];
    clock.setTimeout(() => events.push("later"), 20);
    const cancelled = clock.setTimeout(() => events.push("never"), 5);
    clock.clearTimeout(cancelled);
    clock.setTimeout(() => events.push("first"), 10);
    clock.advanceBy(15);
    expect(events).toEqual(["first"]);
    expect(clock.now()).toBe(15);
    clock.advanceBy(5);
    expect(events).toEqual(["first", "later"]);
  });
});
import { Buffer } from "node:buffer";
