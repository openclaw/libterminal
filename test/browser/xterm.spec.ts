import { expect, test } from "@playwright/test";

test("xterm consumes ordered ANSI and UTF-8 output without Ghostty", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.goto("/xterm");
  const result = await page.evaluate(async () => {
    const exampleUrl = "/xterm-example.js";
    const { mountXterm } = (await import(exampleUrl)) as typeof import("../../examples/xterm.js");
    const bytes = new TextEncoder().encode("\x1b[32mcafé 日本語\x1b[0m");
    const abortable = {
      async *[Symbol.asyncIterator]() {
        yield bytes.subarray(0, 7);
        yield bytes.subarray(7);
      },
    };
    const mounted = mountXterm(document.body, abortable);
    await mounted.done;
    await new Promise<void>((resolve) => mounted.terminal.write("", resolve));
    const text = mounted.terminal.buffer.active.getLine(0)?.translateToString(true);
    mounted.dispose();
    let returned = false;
    const pending = mountXterm(document.body, {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<Uint8Array>>(() => {}),
        return: async () => {
          returned = true;
          return { done: true, value: undefined };
        },
      }),
    });
    pending.dispose();
    await pending.done;
    return { text, returned, terminals: document.querySelectorAll(".xterm").length };
  });
  expect(result).toEqual({ text: "café 日本語", returned: true, terminals: 0 });
  expect(requests.some((url) => /ghostty|\.wasm/.test(url))).toBe(false);
});
