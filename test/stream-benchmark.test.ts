import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runControls, runScenario, validateWorkload } from "../scripts/benchmark-stream.mjs";
import * as stream from "../src/stream.js";

describe("composed stream measurement contracts", () => {
  for (const scenario of ["live", "replay", "drop-oldest", "disconnect"] as const) {
    it(`${scenario} preserves byte parity through direct and batched publication`, async () => {
      const direct = await runScenario(stream, {
        scenario,
        arm: "direct",
        rounds: 3,
        chunkBytes: 7,
      });
      const batched = await runScenario(stream, {
        scenario,
        arm: "batched",
        rounds: 3,
        chunkBytes: 7,
      });
      expect(direct.fast.bytes).toBe(scenario === "replay" ? 105 : 84);
      expect(direct.fast.sha256).toBe(batched.fast.sha256);
      expect(direct.slow.sha256).toBe(batched.slow.sha256);
      expect(direct.fast.writes).toBeGreaterThan(batched.fast.writes);
      expect(direct.parityValid && batched.parityValid).toBe(true);
      expect(direct.cleanupValid && batched.cleanupValid).toBe(true);
      if (scenario === "drop-oldest") {
        expect(direct.evictedBytes).toBe(28);
        expect(batched.evictedBytes).toBe(28);
        expect(direct.overflowEvents).toBe(4);
        expect(batched.overflowEvents).toBe(1);
      }
      if (scenario === "disconnect") {
        expect(direct.rejectedBytes).toBe(7);
        expect(batched.rejectedBytes).toBe(28);
        expect(direct.notOfferedAfterDisconnectBytes).toBe(21);
        expect(batched.notOfferedAfterDisconnectBytes).toBe(0);
      }
    });
  }

  it("checks copying, reentrant replacement, cancellation, drain and error identity", async () => {
    expect(await runControls(stream)).toEqual({
      reentrancy: true,
      copies: true,
      replacement: true,
      cancellation: true,
      errorIdentity: true,
      stopDrain: true,
      iteratorCleanup: true,
    });
  });

  it("rejects workloads that exceed the finite measurement budget", () => {
    for (const rounds of [0, 2, 1025, Infinity, 3.5]) {
      expect(() =>
        validateWorkload({ scenario: "live", arm: "direct", rounds, chunkBytes: 7 }),
      ).toThrow();
    }
    for (const chunkBytes of [0, 4097, NaN]) {
      expect(() =>
        validateWorkload({ scenario: "live", arm: "direct", rounds: 3, chunkBytes }),
      ).toThrow();
    }
  });
});

type SmokeReport = {
  schema: number;
  cancelled: boolean;
  plannedSamples: number;
  validSamples: number;
  invalidSamples: number;
  cells: Array<{
    valid: boolean;
    outcome: string;
    exit: { code: number | null; signal: string | null };
    childReaped: boolean;
    parityValid: boolean;
    cleanupValid: boolean;
    resourceAccountingValid: boolean;
    wholeChildWallMs: number;
    measurement: {
      provenance: { buildSha256: string; harnessSha256: string; node: string };
      metrics: Record<string, number>;
      result: { fast: { sha256: string }; slow: { sha256: string } };
    };
  }>;
};

// `pnpm check` builds first, so this case must run there. Source-only tests may skip it.
it.skipIf(!existsSync(new URL("../dist/stream.js", import.meta.url)))(
  "built public stream CLI emits eight valid fresh-child smoke cells",
  async () => {
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      [fileURLToPath(new URL("../scripts/benchmark-stream.mjs", import.meta.url)), "--smoke"],
      {
        cwd: new URL("../", import.meta.url),
        timeout: 45_000,
        killSignal: "SIGTERM", // The parent cancels and reaps its current measurement child.
        maxBuffer: 256 * 1024,
      },
    );
    expect(stderr).toBe("");
    const report = JSON.parse(stdout) as SmokeReport;
    expect(report.schema).toBe(1);
    expect(report.cancelled).toBe(false);
    expect(report.plannedSamples).toBe(8);
    expect(report.validSamples).toBe(8);
    expect(report.invalidSamples).toBe(0);
    expect(report.cells).toHaveLength(8);
    for (const cell of report.cells) {
      expect(cell.valid).toBe(true);
      expect(cell.outcome).toBe("success");
      expect(cell.exit).toEqual({ code: 0, signal: null });
      expect(cell.childReaped).toBe(true);
      expect(cell.parityValid).toBe(true);
      expect(cell.cleanupValid).toBe(true);
      expect(cell.resourceAccountingValid).toBe(true);
      expect(cell.measurement.provenance.buildSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(cell.measurement.provenance.harnessSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(cell.measurement.provenance.node).toBe(process.version);
      expect(cell.wholeChildWallMs).toBeGreaterThanOrEqual(
        cell.measurement.metrics.operationWallMs,
      );
      for (const value of Object.values(cell.measurement.metrics)) {
        expect(Number.isFinite(value) && value >= 0).toBe(true);
      }
    }
    for (let index = 0; index < report.cells.length; index += 2) {
      const direct = report.cells[index].measurement.result;
      const batched = report.cells[index + 1].measurement.result;
      expect(direct.fast.sha256).toBe(batched.fast.sha256);
      expect(direct.slow.sha256).toBe(batched.slow.sha256);
    }
  },
  60_000,
);
