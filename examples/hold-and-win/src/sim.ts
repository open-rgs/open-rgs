// Run the hold-&-win Zig kernel through the in-WASM batch simulator and print
// an RTP report. The same play.wasm is also loadable as a game via
// `loadWasmMath("./maths/play.wasm")`.
//
//   bun run examples/hold-and-win/src/sim.ts [spins] [seed]

import { resolve } from "node:path";
import { simulateWasmBatch } from "../../../packages/simulator/src/index.js";

const wasm = resolve(import.meta.dir, "../maths/play.wasm");
const spins = Number(process.argv[2] ?? 50_000_000);
const seed = Number(process.argv[3] ?? 1);

const r = await simulateWasmBatch(wasm, { spins, seed });
const pct = (n: number) => (n * 100).toFixed(3) + "%";
console.log(`${r.name} v${r.version} — generic 3x3 hold-&-win (Zig -> WASM)`);
console.log(`  spins:    ${r.spins.toLocaleString()} in ${r.elapsedMs.toFixed(0)}ms (${Math.round(r.spins / (r.elapsedMs / 1000)).toLocaleString()}/s)`);
console.log(`  RTP:      ${pct(r.rtp.measured)} (declared ${pct(r.rtp.declared)}, ${r.rtp.verdict}); 95% CI [${pct(r.rtp.ci95[0])}, ${pct(r.rtp.ci95[1])}]`);
console.log(`  hit rate: ${pct(r.hitRate)}`);
console.log(`  max win:  ${r.multiplier.max}x; stdDev ${r.multiplier.stdDev.toFixed(2)}`);
