import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/browser",
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4179",
    browserName: "chromium",
    headless: true,
  },
  webServer: {
    command: "node scripts/browser-smoke-server.mjs",
    port: 4179,
    reuseExistingServer: false,
  },
});
