import { describe, expect, it, vi } from "vitest";
import { cleanReason, safeClose } from "../src/websocket-close.js";

describe("WebSocket close reason limits", () => {
  it.each([
    ["ASCII", "a".repeat(124), "a".repeat(123)],
    ["two-byte", "é".repeat(62), "é".repeat(61)],
    ["three-byte", "界".repeat(42), "界".repeat(41)],
    ["four-byte", "🦊".repeat(31), "🦊".repeat(30)],
    ["exact boundary", "é".repeat(60) + "界" + "x", "é".repeat(60) + "界"],
    ["surrogate boundary", "a".repeat(120) + "\ud800" + "x", "a".repeat(120) + "\ud800"],
  ])("keeps the complete UTF-8 prefix for %s", (_name, source, expected) => {
    expect(cleanReason(source)).toBe(expected);
    const close = vi.fn();
    safeClose({ close }, 1000, source);
    expect(close).toHaveBeenCalledWith(1000, expected);
    expect(new TextEncoder().encode(expected).byteLength).toBeLessThanOrEqual(123);
  });
});
