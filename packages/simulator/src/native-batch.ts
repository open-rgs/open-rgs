// Native simulator driver. Spawns a standalone native sim binary (built from
// the SAME kernel.zig as the WASM you ship - see test/fixtures/wasm/sim.zig)
// and turns its aggregate into a report. The binary does its own multithreading
// (std.Thread), so one invocation uses all cores: ~1.65B spins/sec measured
// (100M in ~60ms on 10 threads).
//
// SECURITY: this is native (not sandboxed) and a SEPARATE build from the WASM
// artifact, so it is only sound if it is byte-parity with what you ship. The
// kernel is shared source AND there is a parity test (native 1-thread vs WASM
// sim_batch, byte-identical); run it whenever the kernel changes. Use this for
// offline certification sims of your own math only.

import { cpus } from "node:os";
import { basename } from "node:path";
import { reportFromAggregate, type WasmBatchReport } from "./wasm-batch.js";

export interface NativeBatchOptions {
  /** Total spins. Default 1,000,000. */
  spins?: number;
  /** Base seed; the binary derives an independent substream per thread. Default 0. */
  seed?: number;
  /** Worker threads. Default = CPU count. */
  threads?: number;
  /** Declared RTP for the verdict (the native binary doesn't carry one). Required. */
  declaredRtp: number;
  /** Cosmetic, for the report. */
  name?: string;
  version?: string;
}

/** Run a native sim binary (`<bin> <spins> <seedHi> <seedLo> <threads>` ->
 *  JSON aggregate on stdout) and produce a focused RTP report. */
export function simulateNativeBatch(binPath: string, opts: NativeBatchOptions): WasmBatchReport {
  const spins = opts.spins ?? 1_000_000;
  const threads = Math.max(1, opts.threads ?? cpus().length);
  const base = (opts.seed ?? 0) >>> 0;
  const hi = base;
  const lo = (Math.imul(base, 0x9e3779b1) ^ 0x85ebca77) >>> 0;

  const t0 = performance.now();
  const r = Bun.spawnSync([binPath, String(spins), String(hi), String(lo), String(threads)]);
  if (!r.success) {
    throw new Error(`simulateNativeBatch: ${binPath} failed (exit ${r.exitCode}): ${r.stderr.toString().trim()}`);
  }
  let j: { count: number; sum: number; sumsq: number; min: number; max: number; hits: number; elapsedMs?: number };
  try {
    j = JSON.parse(r.stdout.toString());
  } catch {
    throw new Error(`simulateNativeBatch: ${binPath} produced unparseable output: ${r.stdout.toString().slice(0, 200)}`);
  }
  const elapsedMs = j.elapsedMs ?? performance.now() - t0;
  return reportFromAggregate(
    opts.name ?? basename(binPath),
    opts.version ?? "0.0.0",
    { count: j.count, sum: j.sum, sumsq: j.sumsq, min: j.min, max: j.max, hits: j.hits },
    opts.declaredRtp,
    elapsedMs,
  );
}
