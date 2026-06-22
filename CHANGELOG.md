# Changelog

All notable changes to `@openclaw/libterminal` will be documented in this file.

## Unreleased

### Fixed

- Harden release and runtime validation for portable typechecking, browser smoke
  coverage, Ghostty asset discovery, and local stdio cleanup.

## 0.3.1 - 2026-06-19

### Fixed

- Validate PTY buffering before process creation, serialize local stdin writes,
  and suppress abort-only iterator cleanup rejections.
- Keep terminal hub message ordering scoped to each WebSocket connection and
  release browser terminal abort listeners on disposal.
- Trim fragmented terminal replay iteratively instead of recursing.
- Generate Worker Ghostty assets atomically and validate packed packages without
  Windows shell argument reconstruction.
- Require protected semantic release tags for trusted npm publishing and fail
  closed when npm registry lookups fail for reasons other than an unpublished
  version.

## 0.3.0 - 2026-06-19

### Added

- Add an optional Worker-safe Ghostty asset export for serving the pinned
  browser module, WASM, and browser-external shim without application-local
  asset generation.

## 0.2.0 - 2026-06-19

### Added

- Add a browser terminal hub client with terminal protocol framing, ordered
  binary message delivery, and opt-in reconnect scheduling.

## 0.1.2 - 2026-06-18

### Fixed

- Fix release-tag ancestry validation after `main` advances.
- Run the Ghostty browser smoke test before publishing.
- Verify exported declarations and keep pack-check archives out of the repository root.
- Include release scripts in TypeScript checking.

## 0.1.1 - 2026-06-17

### Changed

- Update the TypeScript native-preview development toolchain.
- Update pinned checkout and pnpm setup GitHub Actions.

## 0.1.0 - 2026-06-17

### Added

- Publish terminal protocol v2 codecs and canonical golden vectors.
- Add bounded terminal replay, fanout, batching, and slow-subscriber policies.
- Add read-only-by-default Ghostty browser terminal integration.
- Add optional `node-pty` adapters, local stdio lifecycle helpers, and Ghostty
  asset serving for Node.js.
- Add ordered Worker-compatible WebSocket bridging with fail-closed control
  revalidation and acknowledgement accounting.
- Add product-supplied WebSocket close-reason sanitization.
- Export canonical Ghostty asset paths for Node.js consumers.
- Add reusable terminal, WebSocket, byte, and clock test doubles.

### Fixed

- Preserve caller abort reasons when Ghostty loading is cancelled.
- Close browser stream sources when terminal writes fail.
- Reject JSON values that cannot produce a valid protocol payload.
- Reject invalid unsigned 32-bit subscribe fields instead of coercing them.
- Reject unsupported terminal message types before encoding rather than
  allowing byte coercion.
- Run optional Droid autoreviews from a neutral directory with tools disabled
  so reviewed-repo instructions and configuration cannot affect the reviewer.
- Strip ambient credentials from autoreview subprocess environments.
- Disable reviewer tools and web search unless an engine can enforce a
  repository-scoped read jail.
- Reject oversized review inputs instead of issuing clean verdicts over
  truncated bundles.
- Remove absolute checkout paths from autoreview prompts and bound the final
  aggregate prompt.
- Allow subscribe payloads to request service-selected dimensions with zero
  columns and rows while keeping resize validation strict.
- Always restore local stdio listeners, flowing state, and raw mode when
  terminal output ends, aborts, or iterator cleanup fails.
- Restore local stdio state when the initial terminal resize fails.
- Propagate initial and later asynchronous terminal resize failures through
  stdio cleanup.
- Flush buffered PTY input decoder state exactly once before local session
  teardown.
- Wait for queued WebSocket bridge forwarding to settle before reporting bridge
  completion.
- Align the declared Node.js engine range with the engine-strict locked
  toolchain.
