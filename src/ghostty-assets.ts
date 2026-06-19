export type GhosttyAsset = {
  body: Uint8Array;
  contentType: string;
};

export const GHOSTTY_ASSET_PATHS = {
  module: "/vendor/ghostty-web.js",
  wasm: "/vendor/ghostty-vt.wasm",
  browserExternal: "/vendor/__vite-browser-external-2447137e.js",
} as const;
