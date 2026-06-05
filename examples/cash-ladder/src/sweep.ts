// RTP-vs-policy sweep for the cash-ladder, run ENTIRELY in the kernel
// (sim_ladder self-plays each round), so it's blazing fast. A game with options
// has no single RTP - it has a curve over the policy. Here the policy is "climb
// up to N rungs, then cash out"; we sweep N and print the RTP and throughput.
//
//   bun examples/cash-ladder/src/sweep.ts

import { resolve } from "node:path";
import { readFile } from "node:fs/promises";

interface LadderExports {
  memory: WebAssembly.Memory;
  alloc(n: number): number;
  reset(): void;
  sim_ladder(spins: number, seedHi: number, seedLo: number, stopLevel: number, outP: number): void;
}

const wasm = resolve(import.meta.dir, "../maths/play.wasm");
const bytes = await readFile(wasm);
// sim_ladder uses an in-VM PRNG, so the host imports are never called.
const { instance } = await WebAssembly.instantiate(bytes, { host: { rng_next: () => 0, log_debug: () => {} } });
const ex = instance.exports as unknown as LadderExports;

const SPINS = 50_000_000;
ex.reset();
const outP = ex.alloc(48); // 6 little-endian f64: count,sum,sumsq,min,max,hits

console.log(`cash-ladder RTP by stop-level  (${SPINS.toLocaleString()} self-played rounds each)\n`);
console.log("  stop@   RTP      hit-rate   Mrounds/s");
for (let n = 0; n <= 12; n++) {
  const t0 = performance.now();
  ex.sim_ladder(SPINS, 0x9e3779b9, n + 1, n, outP); // vary seed by n
  const dt = performance.now() - t0;
  const dv = new DataView(ex.memory.buffer, outP, 48);
  const count = dv.getFloat64(0, true);
  const sum = dv.getFloat64(8, true);
  const hits = dv.getFloat64(40, true);
  const rtp = sum / count;
  const hitRate = hits / count;
  const mrps = SPINS / dt / 1000;
  const star = n === 0 ? "  <- optimal (don't gamble)" : "";
  console.log(
    `   ${String(n).padStart(2)}    ${(rtp * 100).toFixed(2)}%    ${(hitRate * 100).toFixed(1).padStart(5)}%     ${mrps.toFixed(0).padStart(6)}${star}`,
  );
}
console.log("\nEach climb has +EV for the house (~4% edge), so RTP falls ~0.96x per rung:");
console.log("the optimal policy here is to not climb at all. A sweep makes that obvious.");
