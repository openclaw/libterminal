# @openclaw/libterminal

Shared TypeScript primitives for streaming, rendering, and bridging terminals
across browsers, Node.js, and Cloudflare Workers.

```ts
import { BoundedReplayBuffer } from "@openclaw/libterminal/stream";
import { decodeTerminalFrame } from "@openclaw/libterminal/protocol";
```

The package deliberately does not own authentication, public listeners,
terminal transcripts, or product-specific room/session state.

## Exports

- `@openclaw/libterminal`: universal terminal types and errors
- `@openclaw/libterminal/protocol`: terminal protocol v2 codecs
- `@openclaw/libterminal/stream`: bounded replay, fanout, and batching
- `@openclaw/libterminal/browser`: Ghostty WASM browser terminal integration
- `@openclaw/libterminal/node`: local PTY, raw stdin, and asset helpers
- `@openclaw/libterminal/worker`: Worker-compatible WebSocket bridging
- `@openclaw/libterminal/testing`: deterministic terminal test doubles

## Development

```sh
pnpm install
pnpm check
```

Shared TypeScript terminal protocol, streaming, browser, Node, and Worker primitives.
