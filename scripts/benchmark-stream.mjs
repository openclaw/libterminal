import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

/** @typedef {import("../src/stream.js").TerminalFanoutOptions} FanoutOptions */
/** @typedef {import("../src/stream.js").BatchPublisherOptions} BatchOptions */
/** @typedef {import("../src/stream.js").TerminalFanout} Fanout */
/** @typedef {import("../src/stream.js").BatchPublisher} Batch */
/** @typedef {Pick<Fanout, "publish" | "subscribe" | "close" | "subscriberCount">} FanoutApi */
/** @typedef {Pick<Batch, "write" | "flush" | "stop">} BatchApi */
/** Public structural signatures accept both source and generated declarations.
 * @typedef {{
 *   TerminalFanout: new (options?: FanoutOptions) => FanoutApi,
 *   BatchPublisher: new (
 *     sink: (bytes: Uint8Array) => Promise<void>, options?: BatchOptions
 *   ) => BatchApi,
 *   attachTerminalStream: typeof import("../src/stream.js").attachTerminalStream
 * }} Stream
 */
/** @typedef {"live" | "replay" | "drop-oldest" | "disconnect"} Scenario */
/** @typedef {"direct" | "batched"} Arm */
/** @typedef {{scenario: Scenario, arm: Arm, rounds: number, chunkBytes: number}} Workload */

const root = new URL("../", import.meta.url);
const script = fileURLToPath(import.meta.url);
const scenarios = /** @type {const} */ (["live", "replay", "drop-oldest", "disconnect"]);
const arms = /** @type {const} */ (["direct", "batched"]);
const deadlineMs = 30_000;
const outputLimit = 64 * 1024;

function barrier() {
  /** @type {() => void} */
  let resolve = () => {};
  /** @type {Promise<void>} */
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A digest sink retains no terminal payload. */
function sink() {
  const hash = createHash("sha256");
  let bytes = 0;
  let writes = 0;
  let wanted = 0;
  let changed = barrier();
  return {
    /** @param {Uint8Array} chunk */
    write(chunk) {
      hash.update(chunk);
      bytes += chunk.byteLength;
      writes += 1;
      if (bytes >= wanted) {
        changed.resolve();
      }
    },
    /** Only one producer acknowledgement may be outstanding. @param {number} target */
    async waitFor(target) {
      wanted = target;
      if (bytes < target) {
        changed = barrier();
        await changed.promise;
      }
      assert.equal(bytes, target);
    },
    result() {
      return { bytes, writes, sha256: hash.digest("hex") };
    },
  };
}

/** @param {Uint8Array} bytes @param {number} index */
function fill(bytes, index) {
  for (let offset = 0; offset < bytes.length; offset += 1) {
    bytes[offset] = (index * 17 + offset * 31) % 251;
  }
  return bytes;
}

/** Independent byte oracle; it does not model the queue implementation.
 * @param {number} first @param {number} count @param {number} chunkBytes
 */
function expected(first, count, chunkBytes) {
  const hash = createHash("sha256");
  const bytes = new Uint8Array(chunkBytes);
  for (let i = first; i < first + count; i += 1) {
    hash.update(fill(bytes, i));
  }
  return { bytes: count * chunkBytes, sha256: hash.digest("hex") };
}

/** @param {Workload} workload */
export function validateWorkload(workload) {
  assert.ok(scenarios.includes(workload.scenario));
  assert.ok(arms.includes(workload.arm));
  assert.ok(
    Number.isSafeInteger(workload.rounds) && workload.rounds >= 3 && workload.rounds <= 1024,
  );
  assert.ok(
    Number.isSafeInteger(workload.chunkBytes) &&
      workload.chunkBytes >= 1 &&
      workload.chunkBytes <= 4096,
  );
}

/** Compose the real public stream primitives with a deterministic, bounded schedule.
 * @param {Stream} stream @param {Workload} workload
 */
export async function runScenario(stream, workload) {
  validateWorkload(workload);
  const { scenario, arm, rounds, chunkBytes } = workload;
  const liveChunks = rounds * 4;
  const prefix = scenario === "replay" ? 12 : 0;
  const replayChunks = prefix ? 3 : 0;
  const overflow = { count: 0, bytes: 0 };
  const closed = new Set();
  const fanout = new stream.TerminalFanout({
    replayBytes: 3 * chunkBytes,
    subscriberBufferBytes: 8 * chunkBytes,
    slowSubscriberPolicy: scenario === "drop-oldest" ? "drop-oldest" : "disconnect",
    onEvent(event) {
      if (event.type === "subscriber-overflow") {
        assert.equal(event.subscriberId, "slow");
        overflow.count += 1;
        overflow.bytes += event.droppedBytes;
      } else {
        assert.ok(!closed.has(event.subscriberId));
        closed.add(event.subscriberId);
      }
    },
  });
  const input = Buffer.alloc(chunkBytes);
  for (let i = 0; i < prefix; i += 1) {
    fanout.publish(fill(input, i));
  }
  const fast = sink();
  const fastSubscription = fanout.subscribe("fast");
  const fastDone = stream.attachTerminalStream(fast, fastSubscription);
  const slowSubscription =
    scenario === "drop-oldest" || scenario === "disconnect"
      ? fanout.subscribe("slow", { replay: false })
      : undefined;
  const batch =
    arm === "batched"
      ? new stream.BatchPublisher(
          async (bytes) => {
            fanout.publish(bytes);
          },
          { maxBatchBytes: 4 * chunkBytes, flushIntervalMs: 60_000 },
        )
      : undefined;
  try {
    await fast.waitFor(replayChunks * chunkBytes);
    for (let i = 0; i < liveChunks; i += 1) {
      fill(input, prefix + i);
      if (batch) {
        batch.write(input);
      } else {
        fanout.publish(input);
      }
      input.fill(255); // Producer reuse must not change retained bytes.
      if (!batch || (i + 1) % 4 === 0) {
        await batch?.flush();
        await fast.waitFor((replayChunks + i + 1) * chunkBytes);
      }
    }
    await batch?.stop();
    fanout.close("measurement complete");
    await fastDone;
    const fastResult = fast.result();
    assert.deepEqual(
      { bytes: fastResult.bytes, sha256: fastResult.sha256 },
      expected(prefix - replayChunks, liveChunks + replayChunks, chunkBytes),
    );
    const slow = sink();
    if (slowSubscription) {
      await stream.attachTerminalStream(slow, slowSubscription);
    }
    const slowResult = slow.result();
    const slowChunks = slowSubscription ? 8 : 0;
    const slowFirst = scenario === "drop-oldest" ? liveChunks - 8 : 0;
    assert.deepEqual(
      { bytes: slowResult.bytes, sha256: slowResult.sha256 },
      expected(slowFirst, slowChunks, chunkBytes),
    );
    const unit = arm === "batched" ? 4 : 1;
    const evicted = scenario === "drop-oldest" ? (liveChunks - 8) * chunkBytes : 0;
    const rejected = scenario === "disconnect" ? unit * chunkBytes : 0;
    assert.equal(overflow.bytes, evicted + rejected);
    assert.equal(
      overflow.count,
      scenario === "drop-oldest" ? (liveChunks - 8) / unit : scenario === "disconnect" ? 1 : 0,
    );
    assert.equal(closed.size, slowSubscription ? 2 : 1);
    assert.equal(fanout.subscriberCount, 0);
    return {
      producedBytes: (prefix + liveChunks) * chunkBytes,
      replayedBytes: replayChunks * chunkBytes,
      fast: fastResult,
      slow: slowResult,
      evictedBytes: evicted,
      rejectedBytes: rejected,
      notOfferedAfterDisconnectBytes:
        scenario === "disconnect" ? (liveChunks - 8 - unit) * chunkBytes : 0,
      overflowEvents: overflow.count,
      closedSubscribers: closed.size,
      parityValid: true,
      cleanupValid: true,
    };
  } finally {
    fanout.close();
    await batch?.stop();
    await fastDone;
  }
}

/** Untimed cross-component controls, also run by the focused test.
 * @param {Stream} stream
 */
export async function runControls(stream) {
  let reentered = false;
  const fanout = new stream.TerminalFanout({
    replayBytes: 1,
    subscriberBufferBytes: 1,
    slowSubscriberPolicy: "drop-oldest",
    onEvent(event) {
      if (event.type === "subscriber-overflow" && !reentered) {
        reentered = true;
        fanout.publish(new Uint8Array([3]));
      }
    },
  });
  const old = fanout.subscribe("copy");
  const peer = fanout.subscribe("peer");
  fanout.publish(new Uint8Array([1]));
  fanout.publish(new Uint8Array([2]));
  assert.equal(reentered, true);
  const oldRead = await old[Symbol.asyncIterator]().next();
  assert.deepEqual(oldRead.value, new Uint8Array([3]));
  oldRead.value?.fill(99);
  assert.deepEqual((await peer[Symbol.asyncIterator]().next()).value, new Uint8Array([3]));
  old.close();
  const replacement = fanout.subscribe("copy");
  old.close();
  assert.equal(fanout.subscriberCount, 2);
  assert.deepEqual((await replacement[Symbol.asyncIterator]().next()).value, new Uint8Array([3]));
  const abort = new AbortController();
  const canceled = stream.attachTerminalStream(
    {
      write() {
        assert.fail("unexpected write");
      },
    },
    replacement,
    abort.signal,
  );
  abort.abort();
  await canceled;
  replacement.close();
  peer.close();
  fanout.close();
  assert.equal(fanout.subscriberCount, 0);

  const failure = new Error("synthetic sink failure");
  const batch = new stream.BatchPublisher(
    async () => {
      throw failure;
    },
    { maxBatchBytes: 8, flushIntervalMs: 60_000 },
  );
  batch.write(new Uint8Array([1]));
  await assert.rejects(batch.stop(), (error) => error === failure);
  await assert.rejects(batch.stop(), (error) => error === failure);
  const drained = sink();
  const tail = new stream.BatchPublisher(
    async (bytes) => {
      drained.write(bytes);
    },
    { maxBatchBytes: 8, flushIntervalMs: 60_000 },
  );
  tail.write(new Uint8Array([1, 2]));
  tail.write(new Uint8Array([3]));
  await tail.stop();
  await tail.stop();
  assert.equal(
    drained.result().sha256,
    createHash("sha256")
      .update(new Uint8Array([1, 2, 3]))
      .digest("hex"),
  );
  let returned = false;
  const source = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          return { done: false, value: new Uint8Array([1]) };
        },
        async return() {
          returned = true;
          throw new Error("synthetic cleanup failure");
        },
      };
    },
  };
  await assert.rejects(
    stream.attachTerminalStream(
      {
        write() {
          throw failure;
        },
      },
      source,
    ),
    (error) => error === failure,
  );
  assert.equal(returned, true);
  return {
    reentrancy: true,
    copies: true,
    replacement: true,
    cancellation: true,
    errorIdentity: true,
    stopDrain: true,
    iteratorCleanup: true,
  };
}

async function identity() {
  const files = (await readdir(new URL("dist/", root)))
    .filter((name) => name.endsWith(".js"))
    .sort();
  assert.ok(files.includes("stream.js"));
  const hash = createHash("sha256");
  for (const name of files) {
    hash.update(name + "\0");
    hash.update(await readFile(new URL(`dist/${name}`, root)));
  }
  const metadata = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  return {
    buildSha256: hash.digest("hex"),
    buildFiles: files,
    harnessSha256: createHash("sha256")
      .update(await readFile(new URL(import.meta.url)))
      .digest("hex"),
    packageManager: metadata.packageManager,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  };
}

/** @param {Workload} workload */
async function measured(workload) {
  const stream = await import("@openclaw/libterminal/stream");
  const provenance = await identity();
  const controls = await runControls(stream);
  await runScenario(stream, { ...workload, rounds: 3, chunkBytes: 16 });
  const rssInitialBytes = process.memoryUsage.rss();
  let rssSamplePeakBytes = rssInitialBytes;
  let rssSamples = 1;
  const sample = () => {
    rssSamplePeakBytes = Math.max(rssSamplePeakBytes, process.memoryUsage.rss());
    rssSamples += 1;
  };
  const timer = setInterval(sample, 10);
  const cpu = process.cpuUsage();
  const start = performance.now();
  try {
    const result = await runScenario(stream, workload);
    const operationWallMs = performance.now() - start;
    const used = process.cpuUsage(cpu);
    sample();
    const rssFinalBytes = process.memoryUsage.rss();
    const lifetimeMaxRssBytes = process.resourceUsage().maxRSS * 1024;
    const resourceAccountingValid = [
      operationWallMs,
      used.user,
      used.system,
      rssInitialBytes,
      rssFinalBytes,
      rssSamplePeakBytes,
      lifetimeMaxRssBytes,
    ].every((value) => Number.isFinite(value) && value >= 0);
    return {
      workload,
      provenance,
      controls,
      result,
      resourceAccountingValid,
      accountingReason: resourceAccountingValid ? null : "non-finite or negative metric",
      metrics: {
        operationWallMs,
        cpuUserUs: used.user,
        cpuSystemUs: used.system,
        rssInitialBytes,
        rssFinalBytes,
        rssSamplePeakBytes,
        rssSamples,
        lifetimeMaxRssBytes,
      },
    };
  } finally {
    clearInterval(timer);
  }
}

/** One owned child at a time; retain failures and bounded diagnostics without terminal data.
 * @param {Workload} workload @param {AbortSignal} signal
 */
async function childCell(workload, signal) {
  const start = performance.now();
  const child = spawn(process.execPath, [script, "--child", JSON.stringify(workload)], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let stderrBytes = 0;
  let outputBytes = 0;
  let outcome = "success";
  /** @type {string | null} */
  let diagnostic = null;
  const kill = (/** @type {string} */ reason) => {
    outcome = reason;
    child.kill("SIGKILL");
  };
  const cancel = () => kill("cancelled");
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) {
    cancel();
  }
  const timer = setTimeout(() => kill("timeout"), deadlineMs);
  child.stdout.on("data", (chunk) => {
    outputBytes += chunk.length;
    if (outputBytes <= outputLimit) {
      output += chunk.toString("utf8");
    } else {
      kill("output-limit");
    }
  });
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes > outputLimit) {
      kill("diagnostic-limit");
    }
  });
  child.on("error", () => {
    diagnostic = "child spawn or process error";
    outcome = "failure";
  });
  /** @type {{ code: number | null, signal: NodeJS.Signals | null }} */
  const exit = await new Promise((resolve) =>
    child.once("close", (code, exitSignal) => resolve({ code, signal: exitSignal })),
  );
  clearTimeout(timer);
  signal.removeEventListener("abort", cancel);
  const wholeChildWallMs = performance.now() - start;
  /** @type {Awaited<ReturnType<typeof measured>> | null} */
  let measurement = null;
  if (outcome === "success" && exit.code === 0) {
    try {
      measurement = JSON.parse(output);
    } catch {
      outcome = "failure";
      diagnostic = "invalid child result";
    }
  } else if (outcome === "success") {
    outcome = "failure";
  }
  if (outcome === "failure" && diagnostic === null) {
    diagnostic = "child exited unsuccessfully";
  }
  const parityValid = measurement?.result?.parityValid === true;
  const cleanupValid = exit.code === 0 && measurement?.result?.cleanupValid === true;
  const resourceAccountingValid = measurement?.resourceAccountingValid === true;
  return {
    workload,
    outcome,
    exit,
    childReaped: true,
    diagnostic,
    stderrBytes,
    parityValid,
    cleanupValid,
    resourceAccountingValid,
    measurement,
    wholeChildWallMs,
    unavailableReason: measurement ? null : "child did not produce a successful measurement",
    valid: outcome === "success" && parityValid && cleanupValid && resourceAccountingValid,
  };
}

async function main() {
  if (process.argv[2] === "--child") {
    assert.equal(process.argv.length, 4);
    const workload = JSON.parse(process.argv[3]);
    validateWorkload(workload);
    process.stdout.write(JSON.stringify(await measured(workload)) + "\n");
    return;
  }
  assert.ok(
    process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === "--smoke"),
  );
  const smoke = process.argv[2] === "--smoke";
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: outputLimit,
  }).trim();
  const sourceDirty =
    execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: root,
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: outputLimit,
    }).length > 0;
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  const cells = [];
  try {
    for (let repetition = 0; repetition < (smoke ? 1 : 3); repetition += 1) {
      for (const scenario of scenarios) {
        const order = repetition % 2 === 0 ? arms : [...arms].reverse();
        for (const arm of order) {
          if (abort.signal.aborted) {
            break;
          }
          const cell = await childCell(
            { scenario, arm, rounds: smoke ? 3 : 64, chunkBytes: smoke ? 32 : 1024 },
            abort.signal,
          );
          cells.push({
            repetition,
            order: cells.length,
            source: { sourceCommit, sourceDirty },
            ...cell,
          });
        }
      }
    }
    const validSamples = cells.filter((cell) => cell.valid).length;
    process.stdout.write(
      JSON.stringify(
        {
          schema: 1,
          cancelled: abort.signal.aborted,
          deadlineMs,
          outputLimitBytes: outputLimit,
          plannedSamples: smoke ? 8 : 24,
          validSamples,
          invalidSamples: cells.length - validSamples,
          cells,
        },
        null,
        2,
      ) + "\n",
    );
    if (abort.signal.aborted || cells.some((cell) => !cell.valid)) {
      process.exitCode = 1;
    }
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(() => {
    process.stderr.write("stream benchmark failed; verify arguments, build, and byte contracts\n");
    process.exitCode = 1;
  });
}
