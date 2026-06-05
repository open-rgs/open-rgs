// In-WASM batch simulator. Runs the entire spin loop INSIDE a WASM math kernel
// (its `sim_batch` export), so 100M+ spins incur no per-spin JS<->WASM boundary
// - only one crossing per chunk. The kernel uses a seeded in-VM PRNG and the
// SAME `decide` logic as its production `play`, so the measured RTP is exactly
// the shipped math's. Sandboxed (WASM) and single-artifact (the same .wasm you
// serve), so there's nothing to re-certify.
//
// Returns a focused RTP-certification report: measured RTP + CI + verdict, hit
// rate, and the multiplier mean/stdDev/min/max - all EXACT from the kernel's
// (count, sum, sumsq, min, max, hits) aggregate. Distribution percentiles and
// outcome-type/mark breakdowns are not produced by the fast path; use the
// per-spin simulator for those.

import { readFile } from "node:fs/promises";

export interface WasmBatchReport {
  name: string;
  version: string;
  spins: number;
  rtp: {
    measured: number;
    declared: number;
    delta: number;
    standardError: number;
    ci95: [number, number];
    verdict: "pass" | "warn" | "fail";
  };
  hitRate: number;
  multiplier: { min: number; max: number; mean: number; stdDev: number };
  elapsedMs: number;
}

export interface WasmBatchOptions {
  /** Total spins to simulate. Default 1,000,000. */
  spins?: number;
  /** Base seed; each chunk derives an independent substream from it. Default 0. */
  seed?: number;
  /** Spins per `sim_batch` call (bounds memory/progress). Default 5,000,000. */
  chunk?: number;
  /** Override the kernel's declared RTP for the verdict (else `rtp_x10000`). */
  declaredRtp?: number;
}

interface BatchExports {
  memory: WebAssembly.Memory;
  name_ptr(): number; name_len(): number;
  version_ptr(): number; version_len(): number;
  rtp_x10000(): number;
  reset?(): void;
  alloc(n: number): number;
  sim_batch(spins: number, seedHi: number, seedLo: number, outP: number): void;
}

function mix32(x: number): number {
  x = Math.imul(x ^ (x >>> 16), 0x85ebca77) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae3d) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

/** Simulate `spins` rounds of a WASM kernel via its in-VM `sim_batch`. */
export async function simulateWasmBatch(wasmPath: string, opts: WasmBatchOptions = {}): Promise<WasmBatchReport> {
  const spins = opts.spins ?? 1_000_000;
  const chunk = Math.max(1, opts.chunk ?? 5_000_000);
  const base = (opts.seed ?? 0) >>> 0;

  const bytes = await readFile(wasmPath);
  // Dummy host imports: sim_batch uses the in-VM PRNG, not host.rng_next.
  const { instance } = await WebAssembly.instantiate(bytes, { host: { rng_next: () => 0, log_debug: () => {} } });
  const ex = instance.exports as unknown as BatchExports;
  if (typeof ex.sim_batch !== "function") {
    throw new Error(`simulateWasmBatch: ${wasmPath} has no 'sim_batch' export  - rebuild the kernel with batch support.`);
  }

  const td = new TextDecoder();
  const readStr = (p: number, l: number): string => td.decode(new Uint8Array(ex.memory.buffer, p, l));
  const name = readStr(ex.name_ptr(), ex.name_len());
  const version = readStr(ex.version_ptr(), ex.version_len());
  const declared = opts.declaredRtp ?? ex.rtp_x10000() / 10000;

  let count = 0, sum = 0, sumsq = 0, min = Infinity, max = 0, hits = 0;
  const t0 = performance.now();
  let done = 0, ci = 0;
  while (done < spins) {
    const n = Math.min(chunk, spins - done);
    const hi = mix32(base ^ Math.imul(ci + 1, 0x9e3779b1)); // independent substream per chunk
    const lo = mix32((base + ci * 2 + 1) >>> 0);
    ci++;
    ex.reset?.();
    const outP = ex.alloc(48);
    ex.sim_batch(n, hi, lo, outP);
    const dv = new DataView(ex.memory.buffer, outP, 48);
    count += dv.getFloat64(0, true);
    sum += dv.getFloat64(8, true);
    sumsq += dv.getFloat64(16, true);
    min = Math.min(min, dv.getFloat64(24, true));
    max = Math.max(max, dv.getFloat64(32, true));
    hits += dv.getFloat64(40, true);
    done += n;
  }
  const elapsedMs = performance.now() - t0;

  const mean = count > 0 ? sum / count : 0;
  const variance = count > 0 ? Math.max(0, sumsq / count - mean * mean) : 0;
  const stdDev = Math.sqrt(variance);
  const measured = mean; // RTP = mean multiplier (the bet cancels)
  const standardError = count > 0 ? stdDev / Math.sqrt(count) : 0;
  const a = Math.abs(measured - declared);
  const verdict: "pass" | "warn" | "fail" =
    standardError === 0 ? (a < 1e-9 ? "pass" : "fail")
    : a <= 1.96 * standardError ? "pass"
    : a <= 2.576 * standardError ? "warn" : "fail";

  return {
    name, version, spins: count,
    rtp: { measured, declared, delta: measured - declared, standardError, ci95: [measured - 1.96 * standardError, measured + 1.96 * standardError], verdict },
    hitRate: count > 0 ? hits / count : 0,
    multiplier: { min: count > 0 ? min : 0, max, mean, stdDev },
    elapsedMs,
  };
}
