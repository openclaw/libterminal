import type { GhosttyAsset } from "./ghostty-assets.js";
import { GHOSTTY_WORKER_ASSET_BASE64 } from "./worker-ghostty-assets.generated.js";

export { GHOSTTY_ASSET_PATHS, type GhosttyAsset } from "./ghostty-assets.js";

const encodedAssets = new Map(Object.entries(GHOSTTY_WORKER_ASSET_BASE64));
const decodedAssets = new Map<string, Uint8Array>();

export function readGhosttyWorkerAsset(pathname: string): GhosttyAsset | null {
  const asset = encodedAssets.get(pathname);
  if (!asset) {
    return null;
  }
  return {
    body: decodedAsset(pathname, asset.base64).slice(),
    contentType: asset.contentType,
  };
}

export function createGhosttyAssetResponse(pathname: string, init?: ResponseInit): Response | null {
  const asset = readGhosttyWorkerAsset(pathname);
  if (!asset) {
    return null;
  }
  const headers = new Headers(init?.headers);
  headers.set("content-type", asset.contentType);
  return new Response(new Uint8Array(asset.body).buffer, { ...init, headers });
}

function decodedAsset(pathname: string, base64: string): Uint8Array {
  let bytes = decodedAssets.get(pathname);
  if (!bytes) {
    const binary = atob(base64);
    bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    decodedAssets.set(pathname, bytes);
  }
  return bytes;
}
