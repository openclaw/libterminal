# Changelog

All notable changes to `@openclaw/libterminal` will be documented in this file.

## Unreleased

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
