# @openclaw/libterminal

TypeScript primitives for terminal protocols, streaming, rendering, and WebSocket
bridges across browsers, Node.js, and Cloudflare Workers.

## Install

```sh
pnpm add @openclaw/libterminal
```

The Node.js adapters require Node.js `^22.18.0 || >=24.11.0`.
Install the optional PTY driver when using `spawnLocalPty()`:

```sh
pnpm add node-pty
```

## Exports

Import the entry point for your runtime. Browser and Worker entry points do not
import Node.js built-ins.

| Entry point | Provides |
| --- | --- |
| `@openclaw/libterminal` | Shared terminal types and errors |
| `/protocol` | Protocol v2 codecs and validation |
| `/stream` | Bounded replay, fanout, and batching |
| `/browser` | Ghostty WASM terminals and terminal hub client |
| `/node` | Local PTYs, raw stdio, and Ghostty assets |
| `/worker` | WebSocket bridging and control checks |
| `/worker-assets` | Embedded Ghostty assets and HTTP responses |
| `/testing` | Deterministic terminal test doubles |

For example:

```ts
import { decodeTerminalFrame } from "@openclaw/libterminal/protocol";
import { BoundedReplayBuffer } from "@openclaw/libterminal/stream";
```

## Streaming

Replay buffers, fanout subscriptions, and batch publishers copy incoming bytes.
Queues are bounded. See [streaming and byte ownership](docs/usage.md#streaming).

## Browser

Create a read-only Ghostty terminal or connect a multiplexed terminal WebSocket.
See [browser integration](docs/usage.md#browser) for assets, cancellation, and color queries.

## Node.js

Spawn a local PTY, attach stdio, or serve Ghostty assets.
See [Node.js integration](docs/usage.md#nodejs) for setup and teardown behavior.

## Workers

Bridge authenticated WebSockets or serve embedded Ghostty assets.
See [Worker integration](docs/usage.md#workers) for control checks and asset routes.

## Protocol

Wire-protocol versions and package versions are independent.
See [protocol compatibility](docs/usage.md#protocol) and the
[protocol v2 specification](protocol/terminal-v2.json).

## Safety

Applications own authentication, authorization, public listeners, storage, and
transcripts. The package does not log or persist terminal bytes.
See the [integration boundaries](docs/usage.md#safety) and [security policy](https://github.com/openclaw/libterminal/blob/main/SECURITY.md).

## Development

Use the pinned pnpm version and a supported development runtime.
See [CONTRIBUTING.md](https://github.com/openclaw/libterminal/blob/main/CONTRIBUTING.md) for setup, validation, review, and release steps.
The [Ghostty validation guide](docs/ghostty-upgrade.md) explains browser e2e coverage
and performance measurements.
