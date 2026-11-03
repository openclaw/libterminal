# Terminal integration guide

[Package overview and installation](../README.md) · [Ghostty upgrade validation](ghostty-upgrade.md)

## Streaming

`TerminalFanout` provides bounded replay and per-subscriber output queues. Close
each subscription when its consumer finishes. You can reuse an ID after closing its subscription.
An old subscription handle cannot close a later subscription with the same ID.

Replay buffers, fanout subscriptions, and batch publishers copy incoming bytes,
including Node.js `Buffer` inputs. Callers can reuse their input buffers after
appending, publishing, or writing. Replay snapshots and subscriber output are
independent copies, so changing one cannot corrupt other readers or stored replay.
The exported testing helpers also copy recorded input and output bytes, including
sources that reuse a `Buffer` between chunks.

## Keep an existing renderer or transport

`attachTerminalStream` accepts an ordered byte iterator and a synchronous
`write(Uint8Array)` target. Import it from `/stream` to avoid Ghostty types and
renderer dependencies. The `/browser` export remains available.

```ts
import { attachTerminalStream } from "@openclaw/libterminal/stream";

await attachTerminalStream(existingTerminal, output, abort.signal);
```

[`examples/xterm.ts`](https://github.com/openclaw/libterminal/blob/main/examples/xterm.ts) connects an actual xterm instance and
owns its cancellation/disposal. Add `@xterm/xterm` and its CSS in your app. Keep
input authorization and your existing WebSocket/SSH transport in the app.
Attachment writes in order but does not wait for asynchronous rendering to finish;
use the renderer's completion callback when you need that guarantee.

`spawnLocalPty({ driver })` already accepts an injected `PtyDriver`. Applications
using a prebuilt or platform-specific PTY package can adapt its `spawn` result to
that interface without adding another driver to libterminal.

## Compatibility and footprint checks

| Surface                | Automated check                                               |
| ---------------------- | ------------------------------------------------------------- |
| Node 22, 24, 26        | Package, unit tests and installed consumer in CI              |
| Browser / Worker       | Existing Ghostty asset parity and Chromium tests              |
| xterm                  | ANSI/UTF-8 rendering, cancellation and disposal in Chromium   |
| Renderer-free consumer | Empty install, strict TypeScript declarations and Vite bundle |

`pnpm pack:check` verifies that installing libterminal alone does not install
Ghostty or node-pty. It reports compressed archive bytes, unpacked package bytes
and compressed root, protocol, stream and Worker consumer bundles separately.
Each portable entry must remain below 12 KB gzip and contain no
Ghostty/embedded-asset modules.

The root archive still contains `/worker-assets` for existing consumers. Moving
that synchronous public export into a separate package requires a coordinated
breaking release; optional peers do not remove those bytes from the archive.

## Browser

Ghostty terminals default to read-only. The application owns authorization,
the byte source, and the WASM asset route.

```ts
import { createGhosttyTerminal } from "@openclaw/libterminal/browser";

async function showOutput(
  parent: HTMLElement,
  output: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
): Promise<void> {
  const terminal = await createGhosttyTerminal({
    parent,
    runtimeOptions: { wasmUrl: "/vendor/ghostty-vt.wasm" },
    signal,
  });
  try {
    await terminal.attach(output, signal);
  } finally {
    terminal.dispose();
  }
}
```

Aborting an attached stream stops buffered output as well as future reads.
Cancellation also stops waiting for source cleanup. Cleanup failures never replace
an existing read or terminal-write failure, and abort-only cleanup errors are ignored.

`ghostty-web` 0.4.0 does not emit responses for OSC 10-12 default-color
queries. Applications that write PTY output into the browser terminal can use
the replay-safe compatibility responder until that support lands upstream:

```ts
import { createTerminalDefaultColorQueryResponder } from "@openclaw/libterminal/browser";

const colorQueries = createTerminalDefaultColorQueryResponder({
  getColors: () => ({
    foreground: "#d7dae0",
    background: "#0e1015",
    cursor: "#ff5c5c",
  }),
  reply: (data) => pty.write(data),
});

colorQueries.primeFromReplay(replayedPrefix);
colorQueries.observe(recoveredSuffix);
colorQueries.observe(liveOutput);
```

When a replay contains an already-observed prefix and a newly recovered suffix,
prime the responder with the prefix before observing the suffix. This prevents
duplicate historical replies while preserving a query split across the seam.

Use `GHOSTTY_ASSET_PATHS` and `readGhosttyAsset()` from the Node.js export to
serve the pinned `ghostty-web` module, WASM, and browser-external shim under
their canonical `/vendor` routes.

`TerminalHubClient` owns protocol framing, binary message normalization, and
optional reconnect scheduling for multiplexed terminal WebSockets. Applications
continue to own URL construction, authorization, session subscriptions, and
terminal lifecycle.

Normalized hub frames own their byte storage, including messages received as
Node.js `Buffer` values from injected transports. Mutable message bytes are copied
when received, before queued delivery, so transports can immediately reuse them.

```ts
import { TerminalHubClient } from "@openclaw/libterminal/browser";

const hub = new TerminalHubClient({
  url: () => terminalHubUrl(),
  shouldReconnect: () => activeTerminalCount() > 0,
  onFrame: handleTerminalFrame,
});
hub.connect();
```

`hub.close(code, reason)` sanitizes invalid close codes and limits the reason to
123 UTF-8 bytes without splitting characters. Valid application codes and reason
whitespace are preserved. Injected transports may accept protocol codes such as
1001 that native browsers reject. These retain their existing behavior. If the
socket rejects the close arguments, the hub retries with code 1000, then without arguments. If every attempt fails, `onError`
receives the final error and the socket remains available for another close attempt.

## Node.js

The built-in adapter dynamically imports the optional `node-pty` peer. Inject a
compatible driver in tests or applications that own their PTY runtime.

```ts
import { attachLocalStdio, spawnLocalPty } from "@openclaw/libterminal/node";

const terminal = await spawnLocalPty({
  command: process.platform === "win32" ? "cmd.exe" : "sh",
  cwd: process.cwd(),
});

await attachLocalStdio(terminal);
```

PTY output queues are bounded by default. Raw stdin mode is restored when the
session ends, errors, or aborts.

Stdio input bytes are copied when received, before queued terminal writes, so
input producers can immediately reuse their buffers.

Aborting a stdio attachment restores it without waiting for a pending write or
resize. Caller-owned streams stay open, and late errors from an outstanding
stdout write remain handled until that write settles.

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

Closing the bridge stops forwarding immediately. `completed` still waits for
already-started message conversions to settle, discarding their results after
teardown.

Use the optional Worker asset export to serve the pinned Ghostty module, WASM,
and browser-external shim without an application-local asset generator. The
product owns the route, cache policy, and security headers.

```ts
import { createGhosttyAssetResponse } from "@openclaw/libterminal/worker-assets";

export default {
  fetch(request: Request): Response {
    return (
      createGhosttyAssetResponse(new URL(request.url).pathname, {
        headers: { "cache-control": "no-store" },
      }) ?? new Response("Not found", { status: 404 })
    );
  },
};
```

## Protocol

`@openclaw/libterminal/protocol` owns terminal protocol v2 codecs and golden
vectors. Strict decoders throw `LibterminalError`. Use `tryDecodeTerminalFrame()`
for nullable migration paths.

Wire-protocol versions and npm package versions are independent compatibility
surfaces.

Subscribe payloads may use zero columns and rows together to ask the terminal
service to select default dimensions. Resize payloads always require real dimensions.

## Safety

- Terminal bytes are never logged or persisted by the package.
- Browser terminals default to read-only.
- Replay, subscriber, and PTY output buffers are bounded.
- Protocol frames and terminal dimensions are validated.
- Authorization, public listeners, storage, and transcripts stay in consumers.
