import { readFile, stat, writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import type { GhosttyTerminalController } from "../../src/browser.js";
import type { TerminalSize } from "../../src/index.js";

declare global {
  interface Window {
    smokeTerminal: GhosttyTerminalController;
    smokeInput: string[];
    smokeResizes: TerminalSize[];
    smokeStartupMs: number;
    smokeRuntimeMs: number;
  }
}

for (const assets of ["node", "worker"]) {
  test(`${assets} assets preserve input, resize, fit, and disposal`, async ({ page }) => {
    const wasm = page.waitForResponse((response) => response.url().endsWith("ghostty-vt.wasm"));
    await page.goto(`/?assets=${assets}`);
    await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
    expect((await wasm).headers()["x-smoke-asset-source"]).toBe(assets);

    await page.evaluate(() => window.smokeTerminal.terminal.focus());
    await page.keyboard.type("ignored");
    expect(await page.evaluate(() => window.smokeInput)).toEqual([]);
    await page.evaluate(() => window.smokeTerminal.setReadOnly(false));
    await page.keyboard.type("input-ok");
    await page.keyboard.press("Enter");
    await expect.poll(() => page.evaluate(() => window.smokeInput.join(""))).toBe("input-ok\r");
    await page.evaluate(() => window.smokeTerminal.setReadOnly(true));
    await page.keyboard.type("ignored-again");
    expect(await page.evaluate(() => window.smokeInput.join(""))).toBe("input-ok\r");

    expect(
      await page.evaluate(() => {
        window.smokeTerminal.resize({ columns: 60, rows: 12 });
        return [window.smokeTerminal.terminal.cols, window.smokeTerminal.terminal.rows];
      }),
    ).toEqual([60, 12]);
    expect(await page.evaluate(() => window.smokeResizes.at(-1))).toEqual({
      columns: 60,
      rows: 12,
    });
    expect(
      await page.evaluate(() => {
        const parent = document.querySelector<HTMLElement>("#terminal")!;
        parent.style.width = "400px";
        parent.style.height = "160px";
        window.smokeTerminal.fit();
        const { cols, rows } = window.smokeTerminal.terminal;
        return cols > 0 && cols < 60 && rows > 0 && rows < 12;
      }),
    ).toBe(true);

    expect(
      await page.evaluate(() => {
        window.smokeTerminal.dispose();
        window.smokeTerminal.dispose();
        try {
          window.smokeTerminal.write(new Uint8Array([65]));
        } catch (error) {
          return (error as { code: string }).code;
        }
        return null;
      }),
    ).toBe("transport_closed");
    await expect(page.locator("#terminal canvas")).toHaveCount(0);
  });

  for (const workload of ["plain", "unicode", "escapes"] as const) {
    test(`${assets} assets sustain ${workload} output and record a baseline`, async ({
      page,
      browser,
    }, testInfo) => {
      test.setTimeout(180_000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`/?assets=${assets}`);
      await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
      const measurements = await page.evaluate(async (kind) => {
        const controller = window.smokeTerminal;
        const terminal = controller.terminal;
        const encoder = new TextEncoder();
        const canvas = document.querySelector<HTMLCanvasElement>("#terminal canvas")!;
        const context = canvas.getContext("2d")!;
        const lines = {
          plain: "The quick brown fox jumps over the lazy dog 0123456789",
          unicode: "Unicode: café Ελληνικά 日本語 中文 한글 🦀",
          escapes: "\x1b[31mred\x1b[0m \x1b[1;4mstyled\x1b[0m\x1b[10Gcolumn\x1b[K",
        };
        const visible = {
          plain: "The quick brown fox",
          unicode: "café 日本語 中文 한글 🦀",
          escapes: "styled red",
        };
        const expectedLine = {
          plain: lines.plain,
          unicode: lines.unicode,
          escapes: "red stylecolumn",
        };
        const samples: Array<{ bytes: number; writeCallMs: number; writeToCanvasMs: number }> = [];
        const browserPerformance = performance as Performance & {
          memory?: { usedJSHeapSize: number };
        };
        const heap = () => browserPerformance.memory?.usedJSHeapSize ?? null;
        let sampledPeakJsHeapBytes = heap();
        let maxBufferLines = 0;
        const expectedLines = ["LIBTERMINAL_SMOKE_OK"];
        controller.write(encoder.encode("\x1b[?25l"));
        // The first batch warms up parsing, fonts, and rendering; the next 32 are measured.
        for (let batch = 0; batch <= 32; batch++) {
          const red = batch % 2 === 0 ? 32 : 96;
          const marker = `BATCH_${batch}_${visible[kind]}`;
          const batchLines = Array.from({ length: 512 }, (_, line) => {
            const suffix = ` #${batch}:${line}`;
            expectedLines.push(expectedLine[kind] + suffix);
            return lines[kind] + suffix + "\r\n";
          });
          expectedLines.push(marker);
          if (expectedLines.length > 4_096) {
            expectedLines.splice(0, expectedLines.length - 4_096);
          }
          const bytes = encoder.encode(
            "\r\n" + batchLines.join("") + `\x1b[48;2;${red};32;48m${marker}\x1b[K\x1b[0m`,
          );
          const started = performance.now();
          controller.write(bytes);
          const writeCallMs = performance.now() - started;
          // Observe a changing background in the last row, not merely an animation-frame callback.
          for (;;) {
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            const pixel = context.getImageData(2, canvas.height - 2, 1, 1).data;
            if (pixel[0] === red && pixel[1] === 32 && pixel[2] === 48) {
              break;
            }
            if (performance.now() - started > 5_000) {
              throw new Error("output was not rendered");
            }
          }
          const writeToCanvasMs = performance.now() - started;
          const buffer = terminal.buffer.active;
          if (buffer.length < Math.min(terminal.rows + 100, expectedLines.length)) {
            throw new Error(`missing retained ${kind} output in batch ${batch}`);
          }
          if (buffer.length >= 4_096) {
            throw new Error("scrollback exceeded the fixed-workload budget");
          }
          for (let row = 0; row < buffer.length; row++) {
            const expected = expectedLines[expectedLines.length - buffer.length + row];
            if (buffer.getLine(row)?.translateToString(true) !== expected) {
              throw new Error(`lost or corrupted ${kind} output in batch ${batch}, row ${row}`);
            }
          }
          maxBufferLines = Math.max(maxBufferLines, buffer.length);
          const usedHeap = heap();
          if (usedHeap !== null) {
            sampledPeakJsHeapBytes = Math.max(sampledPeakJsHeapBytes ?? 0, usedHeap);
          }
          if (batch > 0) {
            samples.push({ bytes: bytes.byteLength, writeCallMs, writeToCanvasMs });
          }
        }
        return {
          runtimeLoadMs: window.smokeRuntimeMs,
          startupMs: window.smokeStartupMs,
          devicePixelRatio,
          columns: terminal.cols,
          rows: terminal.rows,
          scrollback: terminal.options.scrollback,
          maxBufferLines,
          sampledPeakJsHeapBytes,
          samples,
        };
      }, workload);
      expect(errors).toEqual([]);
      // The pinned WASM retains history in chunks; 100 is not an exact line cap.
      // A generous budget still detects retaining the entire 16,896-line workload.
      expect(measurements.maxBufferLines).toBeLessThan(4_096);
      const totalBytes = measurements.samples.reduce((sum, sample) => sum + sample.bytes, 0);
      const totalWriteMs = measurements.samples.reduce(
        (sum, sample) => sum + sample.writeCallMs,
        0,
      );
      const frameTimes = measurements.samples
        .map((sample) => sample.writeToCanvasMs)
        .toSorted((a, b) => a - b);
      const pkg = JSON.parse(await readFile("package.json", "utf8"));
      const baseline = {
        schemaVersion: 1,
        wrapper: pkg.dependencies["ghostty-web"],
        assets,
        workload,
        browser: browser.version(),
        platform: process.platform,
        arch: process.arch,
        viewport: page.viewportSize(),
        wasmBytes: (await stat(new URL(import.meta.resolve("ghostty-web/ghostty-vt.wasm")))).size,
        workerAssetModuleBytes: (await stat("dist/worker-assets.js")).size,
        ...measurements,
        totalBytes,
        writeCallMiBPerSecond:
          totalWriteMs > 0 ? totalBytes / 2 ** 20 / (totalWriteMs / 1000) : null,
        medianWriteToCanvasMs: frameTimes[Math.floor(frameTimes.length / 2)],
        p95WriteToCanvasMs: frameTimes[Math.ceil(frameTimes.length * 0.95) - 1],
      };
      const baselinePath = testInfo.outputPath("ghostty-baseline.json");
      await writeFile(baselinePath, JSON.stringify(baseline, null, 2) + "\n");
      await testInfo.attach("ghostty-baseline", {
        path: baselinePath,
        contentType: "application/json",
      });
      console.log(JSON.stringify({ ghosttyBaseline: { ...baseline, samples: undefined } }));
      await page.evaluate(() => window.smokeTerminal.dispose());
      await expect(page.locator("#terminal canvas")).toHaveCount(0);
    });
  }
}

test("renders streamed output through the pinned Ghostty WASM runtime", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  const canvas = page.locator("#terminal canvas");
  await expect(canvas).toHaveCount(1);
  await expect
    .poll(() =>
      canvas.evaluate((element) => {
        const context = (element as HTMLCanvasElement).getContext("2d");
        if (!context) {
          return 0;
        }
        const pixels = context.getImageData(0, 0, context.canvas.width, context.canvas.height).data;
        const colors = new Set<string>();
        for (let offset = 0; offset < pixels.length; offset += 4) {
          colors.add(
            `${pixels[offset]},${pixels[offset + 1]},${pixels[offset + 2]},${pixels[offset + 3]}`,
          );
          if (colors.size > 1) {
            return colors.size;
          }
        }
        return colors.size;
      }),
    )
    .toBeGreaterThan(1);
});
