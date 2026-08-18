import createMath from "../src/math.js";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const N = Number(process.argv[2] ?? 1_000_000);
const m = createMath({ rng_next: mulberry32(12345), log_debug: () => {} });

let sum = 0, sumSq = 0, hits = 0, features = 0, capped = 0, max = 0;
let lineSum = 0, featSum = 0, fullBoards = 0;
const t0 = performance.now();
for (let i = 0; i < N; i++) {
  const o = m.play();
  sum += o.multiplier; sumSq += o.multiplier * o.multiplier;
  if (o.multiplier > 0) hits++;
  if (o.multiplier > max) max = o.multiplier;
  const f = o.ops.find((x: any) => x.kind === "feature") as any;
  if (f) { features++; featSum += f.won; if (f.full) fullBoards++; }
  else lineSum += o.multiplier;
  if (o.ops.some((x: any) => x.kind === "maxWin")) capped++;
}
const ms = performance.now() - t0;
console.log(`spins            ${N.toLocaleString()}  in ${(ms/1000).toFixed(2)}s  (${Math.round(N/(ms/1000)).toLocaleString()}/s)`);
const mean = sum / N;
const variance = sumSq / N - mean * mean;
const se = Math.sqrt(variance / N);
console.log(`RTP              ${(mean*100).toFixed(2)}%  +/- ${(1.96*se*100).toFixed(2)} (95% CI)`);
console.log(`  volatility     ${Math.sqrt(variance).toFixed(2)} (sd per spin)`);
console.log(`  base lines     ${(lineSum/N*100).toFixed(2)}%`);
console.log(`  feature        ${(featSum/N*100).toFixed(2)}%`);
console.log(`hit rate         ${(hits/N*100).toFixed(2)}%`);
console.log(`feature rate     1 in ${Math.round(N/features).toLocaleString()}  (${(features/N*100).toFixed(3)}%)`);
console.log(`full boards      1 in ${fullBoards ? Math.round(N/fullBoards).toLocaleString() : "never"}`);
console.log(`max win hit      ${capped}   top win ${max.toFixed(1)}x`);
