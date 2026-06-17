import { describe, expect, it } from "vitest";
import { assertTerminalSize, LibterminalError } from "../src/index.js";

describe("assertTerminalSize", () => {
  it("accepts valid terminal dimensions", () => {
    expect(assertTerminalSize({ columns: 120, rows: 34 })).toEqual({ columns: 120, rows: 34 });
  });

  it("rejects invalid terminal dimensions with a stable error code", () => {
    expect(() => assertTerminalSize({ columns: 0, rows: 34 })).toThrowError(
      expect.objectContaining<Partial<LibterminalError>>({ code: "invalid_terminal_size" }),
    );
  });
});
