import { describe, expect, it } from "vitest";
import { GHOSTTY_ASSET_PATHS as nodeAssetPaths, readGhosttyAsset } from "../src/node.js";
import {
  createGhosttyAssetResponse,
  GHOSTTY_ASSET_PATHS,
  readGhosttyWorkerAsset,
} from "../src/worker-assets.js";

describe("Worker Ghostty assets", () => {
  it(
    "embeds byte-exact copies of the pinned Ghostty browser assets",
    { timeout: 10_000 },
    async () => {
      expect(GHOSTTY_ASSET_PATHS).toEqual(nodeAssetPaths);

      for (const pathname of Object.values(GHOSTTY_ASSET_PATHS)) {
        const expected = await readGhosttyAsset(pathname);
        const actual = readGhosttyWorkerAsset(pathname);
        expect(expected, pathname).not.toBeNull();
        expect(actual, pathname).not.toBeNull();
        expect(actual!.contentType).toBe(expected!.contentType);
        expect(Buffer.from(actual!.body)).toEqual(Buffer.from(expected!.body));
      }
    },
  );

  it("keeps decoded asset bytes isolated from caller mutation", () => {
    const asset = readGhosttyWorkerAsset(GHOSTTY_ASSET_PATHS.wasm);
    expect(asset).not.toBeNull();
    asset!.body.fill(0);
    expect(readGhosttyWorkerAsset(GHOSTTY_ASSET_PATHS.wasm)?.body).not.toEqual(asset!.body);
  });

  it("isolates response bodies from later reads and other response consumers", async () => {
    const pathname = GHOSTTY_ASSET_PATHS.browserExternal;
    const expected = readGhosttyWorkerAsset(pathname)!.body;
    const first = createGhosttyAssetResponse(pathname)!;
    const second = createGhosttyAssetResponse(pathname)!;
    readGhosttyWorkerAsset(pathname)!.body.fill(0);
    const consumed = new Uint8Array(await first.arrayBuffer());
    expect(consumed).toEqual(expected);
    consumed.fill(0);
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(expected);
    const later = createGhosttyAssetResponse(pathname)!;
    expect(new Uint8Array(await later.arrayBuffer())).toEqual(expected);
  });

  it("builds responses with canonical content types and caller policy", async () => {
    const response = createGhosttyAssetResponse(GHOSTTY_ASSET_PATHS.wasm, {
      headers: {
        "cache-control": "no-store",
        "content-type": "text/plain",
        "x-terminal-policy": "viewer",
      },
    });

    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toBe("application/wasm");
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(response?.headers.get("x-terminal-policy")).toBe("viewer");
    expect((await response?.arrayBuffer())?.byteLength).toBeGreaterThan(0);
    expect(createGhosttyAssetResponse("/vendor/missing")).toBeNull();
  });
});
