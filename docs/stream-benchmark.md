# Composed stream measurement

This opt-in repository tool measures a synthetic producer, the public `/stream`
entry point, and digest sinks together. It supplies byte and lifecycle checks
alongside raw wall time, CPU, and process memory observations. It does not measure
terminal rendering, PTY children, browser or Worker memory, installation, or
bundle size. It cannot attribute CPU or memory to the queue alone.

Use the supported Node.js and pinned pnpm versions from `package.json`, with a
qualified dependency installation. From a clean checkout, build and check first:

```bash
pnpm check
node scripts/benchmark-stream.mjs --smoke
node scripts/benchmark-stream.mjs
```

The CLI imports the built public `@openclaw/libterminal/stream` entry point.
The focused Vitest test injects the real source module into the same scenarios;
it does not substitute a queue model or require an earlier build. The script and
test are repository tools, not new package exports.

A separate focused integration case runs the built CLI smoke command, checking
all eight child results and their identities. It explicitly skips when
`dist/stream.js` is absent for source-only test runs. The mandatory `pnpm check`
builds before running tests, so this case must run and pass in that gate; a skipped
case is not built-export validation. Its 45-second subprocess timeout sends
SIGTERM to the benchmark parent, which cancels and reaps its current child.

## Workloads and byte checks

Each fresh child runs one cell: one scenario, publication arm, and repetition.
The full command runs 24 cells sequentially: four scenarios, two arms, and three
repetitions. The smoke command runs eight smaller cells. Full cells use 64 rounds
of four 1,024-byte chunks; smoke cells use three rounds of four 32-byte chunks.
The arm order alternates between repetitions, with zero-based order recorded.
Scenarios remain in a fixed order; this is not a randomized experiment.

- **Live:** a fast digest sink acknowledges each direct chunk or four-chunk batch.
- **Replay:** publish 12 chunks before subscribing. Retain three chunks of replay,
  acknowledge that replay, then consume live output.
- **Drop oldest:** hold a second subscriber unread until publication finishes.
  Its eight-chunk capacity must retain exactly the final eight chunks.
- **Disconnect:** hold that subscriber in the same way. It retains the first eight
  chunks, rejects the next publication, closes, and drains its retained bytes.
  The fast subscriber must still receive the complete stream.

Every chunk uses a deterministic byte pattern. Producers reuse and overwrite one
Buffer after every write. Independent expected SHA-256 digests check order and
bytes without retaining all output. Subscriber acknowledgements establish the
schedule; no sleep is used to approximate consumer readiness. There is at most
one outstanding batch flush. `BatchPublisher.write()` is not producer backpressure.

Reports separate produced, replayed, delivered, evicted, rejected, and bytes not
offered after disconnection. These are not interchangeable counters: the rejected
publication is four chunks in the batched arm, and one in the direct arm. Writes
and overflow events also differ by arm. Do not add subscriber byte totals and
expect them to equal producer bytes.

Untimed controls check subscriber/replay copy isolation, reentrant publication,
replacement subscription identity, cancellation with explicit subscription close,
ordered stop/drain, and preservation of sink errors through failed cleanup.
One small scenario warmup follows the controls in each child. No timing threshold
is used in tests or CI.

## Measurement windows and validity

The operation window surrounds the complete measured scenario, including producer
generation, stream setup, acknowledgements, digest work, expected-byte checks,
drain, and teardown. It excludes import, identity collection, controls, and warmup.
The parent whole-child window starts immediately before spawning Node and ends
after the child's `close` event. It includes those excluded setup steps, process
startup, result serialization, and pipe closure. Neither window isolates batching
or queue implementation cost.

- `operationWallMs` and `wholeChildWallMs`: monotonic elapsed milliseconds.
- `cpuUserUs`, `cpuSystemUs`: process CPU microsecond deltas for the operation.
  They include all activity in that child, including measurement overhead.
- `rssInitialBytes`, `rssFinalBytes`: process RSS at the operation boundaries.
- `rssSamplePeakBytes`: maximum initial, final, and 10 ms timer sample. The timer
  can miss short peaks or never fire during a busy microtask sequence. `rssSamples`
  includes boundary samples; it does not prove continuous observation.
- `lifetimeMaxRssBytes`: Node's process-lifetime `maxRSS` in KiB, converted to bytes.
  It includes startup, controls, warmup, and the operation. Subtracting RSS values
  does not measure allocated queue bytes, and garbage collection is not forced.

Each cell records the parent's initial commit and dirty status, a SHA-256 over sorted top-level built
JavaScript filenames and bytes, harness hash, Node version, OS family,
architecture, and the repository's package-manager pin. The pin is not evidence
of which pnpm built the files. A build hash identifies bytes; it does not prove
they came from the recorded source. Keep the clean rebuild/toolchain evidence
with any comparison. Hostnames, paths, and terminal contents are not reported.

Each cell retains outcome, exit code/signal, child reaping, byte parity, in-scenario
cleanup, resource-accounting validity, and raw metrics separately. A missing
measurement is `null` with a reason, never an invented zero. Failed cells remain
in the report and make the command fail; cancelled runs also report planned and
completed sample counts. `validSamples` counts only cells with successful exit,
parity, cleanup, and accounting. A forced child kill proves process reaping, not
successful stream cleanup. Raw stderr content is suppressed; only its byte count
and a fixed diagnostic category are retained.

Each child has a 30-second deadline and separate 64 KiB stdout/stderr limits.
Cancellation or a limit kills only that directly spawned child, then waits for
its close event. Measured children create no subprocesses or files. Before the
cells, the parent runs two read-only Git identity commands with five-second
timeouts and bounded output. SIGINT/SIGTERM
cancel the current child and prevent later cells from starting.

Do not draw a performance conclusion from invalid parity, cleanup, or accounting,
or compare runs without matching source/build, workload, toolchain, platform,
background-load conditions, and measurement windows. Report raw repetitions and
valid counts before any summary. These bounded synthetic measurements are not
evidence for renderer/PTY throughput, production latency, or a queue rewrite.
