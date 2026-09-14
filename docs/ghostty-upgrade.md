# Ghostty runtime upgrade validation

[Issue #41](https://github.com/openclaw/libterminal/issues/41) tracks adopting
Ghostty v1.4 through a maintained, published browser/WASM wrapper. The runtime
remains pinned to `ghostty-web@0.4.0` until a stable Ghostty v1.4 tag and a stable
compatible wrapper are both published. Do not fork or patch the C/WASM ABI here.

As checked on September 14, 2026, Ghostty's `v1.4.0` tag was absent, npm's stable
`ghostty-web` version was `0.4.0`, and upstream wrapper PRs
[#169](https://github.com/coder/ghostty-web/pull/169) and
[#182](https://github.com/coder/ghostty-web/pull/182) were still open. This is
validation groundwork, not a runtime upgrade or a performance improvement claim.

## Run the baseline

```sh
pnpm test:browser
# Only the six workload/asset combinations:
pnpm test:browser --grep 'record a baseline'
```

The smoke server serves the built `dist/browser.js` with either
`readGhosttyAsset()` (`/?assets=node`) or the built `readGhosttyWorkerAsset()`
(`/?assets=worker`). The Worker case tests the embedded asset bytes in a browser;
it does not emulate a deployed Cloudflare Worker. The lifecycle checks verify
default read-only input, writable keyboard events, returning to read-only,
explicit resize and its callback, fitting, and idempotent disposal. Unit tests
also compare the Node and Worker module, WASM, and shim bytes exactly.

Each workload uses a fresh page, an 80-by-20 terminal, and `scrollback: 100`.
After one warmup batch, it measures 32 batches of 512 individually numbered
synthetic lines. Each batch ends with an ASCII/Unicode marker and an alternating
background. The test checks every retained line through the public terminal
buffer, verifies a minimum retained history, and waits until the canvas's last
row actually has the new background. This catches dropped writes, corrupted
Unicode tails, and stalled rendering rather than accepting an already-nonblank
canvas. Plain, Unicode/CJK, and escape-heavy byte counts differ; compare each
workload only with the same workload in another build.

Every workload logs a `ghosttyBaseline` JSON object and attaches the full result
as `ghostty-baseline` in Playwright's `test-results/` directory. The record includes
the pinned wrapper version, browser version, platform, architecture, viewport,
device pixel ratio, terminal dimensions, raw samples, and these measurements:

| Measurement                                   | Meaning and limits                                                                                                                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtimeLoadMs`                               | Libterminal and wrapper module imports, then WASM fetch/initialization through `loadGhosttyRuntime`. Fresh page; not a guaranteed cold browser or OS cache.                           |
| `startupMs`                                   | Runtime load plus terminal construction/open, before the first output write.                                                                                                          |
| `writeCallMiBPerSecond`                       | Bytes divided by time inside controller `write()` calls. The current wrapper parses synchronously; reassess this measurement if an upgrade queues writes. Not parser-only throughput. |
| `medianWriteToCanvasMs`, `p95WriteToCanvasMs` | Time from write start until the changed background is observed in canvas pixels, including frame scheduling and pixel readback. Not physical display presentation latency.            |
| `wasmBytes`, `workerAssetModuleBytes`         | Uncompressed shipped WASM and built Worker asset module sizes, respectively; not total bundle or network transfer size.                                                               |
| `sampledPeakJsHeapBytes`                      | Chromium's sampled `performance.memory.usedJSHeapSize`, or null when unavailable. May be quantized; excludes complete WASM/native/process memory and can miss between-sample peaks.   |
| `maxBufferLines`                              | Largest public buffer length observed after a batch, including the visible screen.                                                                                                    |

The current WASM retains scrollback in chunks: requesting 100 history lines does
not impose an exact 100-line cap. The smoke test uses a generous 4,096-line budget
to catch retention of the entire 16,896-line workload while recording the actual
maximum. This is a regression check for this fixed workload, not a general memory
bound. Do not hide this behavior by adding a private ABI shim.

Timing values are diagnostic; CI does not impose speed thresholds on the recorded
metrics. Functional waits allow five seconds per batch and three minutes per
workload test to detect hangs. Run baseline and candidate repeatedly on the same machine, browser,
viewport, and workload. Preserve the raw JSON and record comparable results in
the adoption PR. Shared CI runners are useful for behavior checks, not precise
cross-run performance comparisons.

## Completing the upgrade

Once both publication gates are met, pin the qualifying stable wrapper, verify
its provenance and reproducible build, and check the public runtime lifecycle
and browser/Node/Worker asset contracts. Regenerate assets with
`pnpm generate:worker-assets` and run `pnpm check` and `pnpm check:release`.

Keep the OSC 10–12 compatibility responder until browser proof demonstrates
that the replacement emits the required responses itself. Record comparable
before/after measurements, including complete peak memory under bounded
scrollback; the sampled JS heap diagnostic above does not satisfy that memory
requirement. The issue remains open until the stable dependency is adopted and
all its acceptance criteria have been verified.
