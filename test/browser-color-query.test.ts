import { describe, expect, it, vi } from "vitest";
import { createTerminalDefaultColorQueryResponder } from "../src/browser.js";

const DARK_COLORS = { foreground: "#d7dae0", background: "#0e1015", cursor: "#ff5c5c" };
const LIGHT_COLORS = { foreground: "#1b1e26", background: "#f7f8fa", cursor: "#1b1e26" };

describe("terminal default-color query responder", () => {
  it("answers OSC 10 and 11 queries with Ghostty-compatible RGB values", () => {
    const reply = vi.fn();
    const responder = createTerminalDefaultColorQueryResponder({
      getColors: () => DARK_COLORS,
      reply,
    });

    responder.observe("prefix\u001b]10;?\u001b\\\u001b]11;?\u0007suffix");

    expect(reply.mock.calls.map(([data]) => data)).toEqual([
      "\u001b]10;rgb:d7d7/dada/e0e0\u001b\\",
      "\u001b]11;rgb:0e0e/1010/1515\u0007",
    ]);
  });

  it("answers successive slots and preserves the request terminator", () => {
    const reply = vi.fn();
    const responder = createTerminalDefaultColorQueryResponder({
      getColors: () => DARK_COLORS,
      reply,
    });

    responder.observe("\u001b]10;?;?;?\u0007");

    expect(reply.mock.calls.map(([data]) => data)).toEqual([
      "\u001b]10;rgb:d7d7/dada/e0e0\u0007",
      "\u001b]11;rgb:0e0e/1010/1515\u0007",
      "\u001b]12;rgb:ffff/5c5c/5c5c\u0007",
    ]);
  });

  it("recognizes each query across every stream split", () => {
    for (const query of ["\u001b]10;?\u0007", "\u001b]11;?\u001b\\"]) {
      for (let split = 1; split < query.length; split += 1) {
        const reply = vi.fn();
        const responder = createTerminalDefaultColorQueryResponder({
          getColors: () => DARK_COLORS,
          reply,
        });

        responder.observe(query.slice(0, split));
        expect(reply).not.toHaveBeenCalled();
        responder.observe(query.slice(split));

        expect(reply).toHaveBeenCalledOnce();
      }
    }
  });

  it("uses current colors when the terminal theme changes", () => {
    let colors = DARK_COLORS;
    const reply = vi.fn();
    const responder = createTerminalDefaultColorQueryResponder({
      getColors: () => colors,
      reply,
    });

    responder.observe("\u001b]11;?\u001b\\");
    colors = LIGHT_COLORS;
    responder.observe("\u001b]11;?\u001b\\");

    expect(reply.mock.calls.map(([data]) => data)).toEqual([
      "\u001b]11;rgb:0e0e/1010/1515\u001b\\",
      "\u001b]11;rgb:f7f7/f8f8/fafa\u001b\\",
    ]);
  });

  it("advances past setters while replying to later query slots", () => {
    const reply = vi.fn();
    const responder = createTerminalDefaultColorQueryResponder({
      getColors: () => DARK_COLORS,
      reply,
    });

    responder.observe("\u001b]10;#ffffff;?\u001b\\");

    expect(reply).toHaveBeenCalledWith("\u001b]11;rgb:0e0e/1010/1515\u001b\\");
  });

  it("advances past empty fields while replying to later query slots", () => {
    const reply = vi.fn();
    const responder = createTerminalDefaultColorQueryResponder({
      getColors: () => DARK_COLORS,
      reply,
    });

    responder.observe("\u001b]10;;?\u0007");

    expect(reply).toHaveBeenCalledWith("\u001b]11;rgb:0e0e/1010/1515\u0007");
  });

  it("queues replies before invoking a synchronous reentrant callback", () => {
    const replies: string[] = [];
    let responder: ReturnType<typeof createTerminalDefaultColorQueryResponder>;
    responder = createTerminalDefaultColorQueryResponder({
      getColors: () => DARK_COLORS,
      reply: (data) => {
        replies.push(data);
        if (replies.length === 1) {
          responder.observe("\u001b]12;?\u0007");
        }
      },
    });

    responder.observe("\u001b]10;?;?\u0007");

    expect(replies).toEqual([
      "\u001b]10;rgb:d7d7/dada/e0e0\u0007",
      "\u001b]11;rgb:0e0e/1010/1515\u0007",
      "\u001b]12;rgb:ffff/5c5c/5c5c\u0007",
    ]);
  });

  it("restarts at a new OSC after an unterminated query", () => {
    const reply = vi.fn();
    const responder = createTerminalDefaultColorQueryResponder({
      getColors: () => DARK_COLORS,
      reply,
    });

    responder.observe("\u001b]11;junk\u001b]10;?\u0007");

    expect(reply).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledWith("\u001b]10;rgb:d7d7/dada/e0e0\u0007");
  });

  it("recovers from canceled color queries", () => {
    const reply = vi.fn();
    const responder = createTerminalDefaultColorQueryResponder({
      getColors: () => DARK_COLORS,
      reply,
    });

    responder.observe("\u001b]11;junk\u0018\u001b]10;?\u0007");

    expect(reply).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledWith("\u001b]10;rgb:d7d7/dada/e0e0\u0007");
  });

  it("ignores unrelated commands and invalid color values", () => {
    const reply = vi.fn();
    const responder = createTerminalDefaultColorQueryResponder({
      getColors: () => ({ ...DARK_COLORS, background: "transparent" }),
      reply,
    });

    responder.observe("\u001b]13;?\u001b\\\u001b]11;?\u001b\\");

    expect(reply).not.toHaveBeenCalled();
  });

  it("suppresses replay replies while retaining a trailing query prefix", () => {
    const reply = vi.fn();
    const responder = createTerminalDefaultColorQueryResponder({
      getColors: () => DARK_COLORS,
      reply,
    });

    responder.primeFromReplay("\u001b]10;?\u001b\\history\u001b]11;");
    expect(reply).not.toHaveBeenCalled();
    responder.observe("?\u001b\\");

    expect(reply).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledWith("\u001b]11;rgb:0e0e/1010/1515\u001b\\");
  });

  it("recovers after an oversized unterminated color sequence", () => {
    const reply = vi.fn();
    const responder = createTerminalDefaultColorQueryResponder({
      getColors: () => DARK_COLORS,
      reply,
    });

    responder.observe(`\u001b]10;${"x".repeat(1025)}`);
    responder.observe("\u001b]11;?\u0007");

    expect(reply).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledWith("\u001b]11;rgb:0e0e/1010/1515\u0007");
  });
});
