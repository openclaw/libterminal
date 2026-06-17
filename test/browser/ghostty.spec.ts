import { expect, test } from "@playwright/test";

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
