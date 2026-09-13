import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/worker-ghostty-assets.generated.ts"],
      reporter: ["text", "html", "json-summary"],
    },
  },
});
