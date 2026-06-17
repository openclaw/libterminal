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
- Add reusable terminal, WebSocket, byte, and clock test doubles.

### Fixed

- Always restore local stdio listeners and raw mode when terminal output
  iteration or iterator cleanup fails.
