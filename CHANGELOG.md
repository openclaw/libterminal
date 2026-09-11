# Changelog

All notable changes to `@openclaw/libterminal` will be documented in this file.

## 0.3.6 - Unreleased

### Fixed

- Keep dependency updates compatible with Dependabot by pinning pnpm 11.26.0 without the extra native-binary bootstrap download.

### Changed

- Refresh Node.js types, oxfmt, and oxlint while preserving the two-day dependency cooldown.
- Update pinned CodeQL analysis actions to 4.38.0. (#62, thanks @dependabot)

## 0.3.5 - 2026-09-07

**Highlights:** Close terminal hub connections reliably when callers supply invalid WebSocket close codes or oversized reasons.

### Fixed

- Prevent `TerminalHubClient.close()` from leaking sockets when native WebSocket rejects a close code or reason; preserve valid reason text and report final teardown failures. (#60, thanks @SebTardif)

### Changed

- Refresh browser validation to Playwright 1.63 and update pnpm to 12.3.4 with its pnpm 12-compatible setup action, preserving the two-day dependency cooldown.
- Refresh the transitive nanoid dependency to fix its custom-generator infinite-loop advisory in the development toolchain.

## 0.3.4 - 2026-09-05

### Changed

- Refresh the build and test toolchain to tsdown 0.23, Vitest 5, and pnpm 12 while preserving the two-day dependency cooldown; development now requires Node.js 22.18+, 24.11+, or 26+.
- Refresh oxfmt, oxlint, Node.js types, and transitive development dependencies. (#56, #57, thanks @dependabot)

## 0.3.3 - 2026-08-31

### Changed

- Refresh development dependencies, pnpm, and the pinned CodeQL action while preserving the two-day dependency cooldown.

### Fixed

- Handle stdout errors, including EPIPE, in `attachLocalStdio` so closed pipes reject the attachment and restore stdio instead of crashing the process. (#54, thanks @SebTardif)
- Stop `BatchPublisher` from copying and buffering output after a sink failure, preventing unbounded memory growth after transport closure. (#55, thanks @SebTardif)
- Route stdin stream errors through `attachLocalStdio` failure handling so pipe errors reject the attachment and restore stdio instead of crashing the process. (#50, thanks @SebTardif)

## 0.3.2 - 2026-07-15

### Fixed

- Add a bounded, replay-safe browser responder for OSC 10-12 default-color
  queries while Ghostty's WASM handler lacks those replies.
- Accept npm 12's keyed `npm pack --json` output during package validation.
- Harden release and runtime validation for portable typechecking, browser smoke
  coverage, Ghostty asset discovery, and local stdio cleanup.
- Pin dependency automation to the public npm registry so public scoped packages
  do not resolve through GitHub Packages.

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
