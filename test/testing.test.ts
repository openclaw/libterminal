import { describe, expect, it } from "vitest";
import {
  collectTerminalOutput,
  createFakeTerminalDuplex,
  ManualClock,
  terminalBytes,
  terminalText,
} from "../src/testing.js";

describe("testing helpers", () => {
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
