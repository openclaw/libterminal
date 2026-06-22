# @openclaw/libterminal

Shared TypeScript primitives for streaming, rendering, and bridging terminals
across browsers, Node.js, and Cloudflare Workers.

```ts
import { BoundedReplayBuffer } from "@openclaw/libterminal/stream";
import { decodeTerminalFrame } from "@openclaw/libterminal/protocol";
```

The package deliberately does not own authentication, public listeners,
terminal transcripts, or product-specific room/session state.

## Install

```sh
pnpm add @openclaw/libterminal
```

Install `node-pty` in applications that use the Node.js PTY adapter:

```sh
pnpm add node-pty
```

## Exports

- `@openclaw/libterminal`: universal terminal types and errors
- `@openclaw/libterminal/protocol`: terminal protocol v2 codecs
- `@openclaw/libterminal/stream`: bounded replay, fanout, and batching
- `@openclaw/libterminal/browser`: Ghostty WASM terminal integration and terminal hub client
- `@openclaw/libterminal/node`: local PTY, raw stdin, and asset helpers
- `@openclaw/libterminal/worker`: Worker-compatible WebSocket bridging
- `@openclaw/libterminal/worker-assets`: optional Worker-safe Ghostty asset payloads
- `@openclaw/libterminal/testing`: deterministic terminal test doubles

## Browser

Ghostty terminals default to read-only. The application owns authorization,
the byte source, and the WASM asset route.

```ts
import { createGhosttyTerminal } from "@openclaw/libterminal/browser";

const terminal = await createGhosttyTerminal({
  parent: document.querySelector("#terminal")!,
  runtimeOptions: { wasmUrl: "/vendor/ghostty-vt.wasm" },
  signal: controller.signal,
});

await terminal.attach(output);
```

Use `GHOSTTY_ASSET_PATHS` and `readGhosttyAsset()` from the Node.js export to
serve the pinned `ghostty-web` module, WASM, and browser-external shim under
their canonical `/vendor` routes.

`TerminalHubClient` owns protocol framing, binary message normalization, and
optional reconnect scheduling for multiplexed terminal WebSockets. Applications
continue to own URL construction, authorization, session subscriptions, and
terminal lifecycle.

```ts
import { TerminalHubClient } from "@openclaw/libterminal/browser";

const hub = new TerminalHubClient({
  url: () => terminalHubUrl(),
  shouldReconnect: () => activeTerminalCount() > 0,
  onFrame: handleTerminalFrame,
});
hub.connect();
```

## Node.js

The built-in adapter dynamically imports the optional `node-pty` peer. Inject a
compatible driver in tests or applications that own their PTY runtime.

```ts
import { attachLocalStdio, spawnLocalPty } from "@openclaw/libterminal/node";

const terminal = await spawnLocalPty({
  command: "codex",
  args: ["--yolo"],
  cwd: process.cwd(),
});

await attachLocalStdio(terminal);
```

PTY output queues are bounded by default. Raw stdin mode is restored when the
session ends, errors, or aborts.

## Workers

The Worker bridge forwards both directions in order and can revalidate control
before every left-to-right message and on a periodic fail-closed timer.

```ts
import { bridgeWebSockets } from "@openclaw/libterminal/worker";

const bridge = bridgeWebSockets(viewer, terminal, {
  canSendLeft: async () => capabilities.canControl(sessionId),
  sanitizeCloseReason: redactCredentials,
});

await bridge.completed;
```

The product remains responsible for authenticating both sockets and deciding
which capabilities grant control.

Use the optional Worker asset export to serve the pinned Ghostty module, WASM,
and browser-external shim without an application-local asset generator. The
product owns the route, cache policy, and security headers.

```ts
import { GHOSTTY_ASSET_PATHS, readGhosttyWorkerAsset } from "@openclaw/libterminal/worker-assets";

const asset = readGhosttyWorkerAsset(new URL(request.url).pathname);
if (asset) {
  return new Response(asset.body, {
    headers: {
      "cache-control": "no-store",
      "content-type": asset.contentType,
    },
  });
}
```

## Protocol

`@openclaw/libterminal/protocol` owns terminal protocol v2 codecs and golden
vectors. Strict decoders throw `LibterminalError`; `tryDecodeTerminalFrame()`
is available for nullable migration paths.

Subscribe payloads may use zero columns and rows together to ask the terminal
service to select default dimensions. Resize payloads always require real
dimensions.

Wire-protocol versions and npm package versions are independent compatibility
surfaces.

## Safety

- Terminal bytes are never logged or persisted by the package.
- Browser terminals default to read-only.
- Replay, subscriber, and PTY output buffers are bounded.
- Protocol frames and terminal dimensions are validated.
- Authorization, public listeners, storage, and transcripts stay in consumers.

## Development

```sh
pnpm install
pnpm check
pnpm run check:release
```
