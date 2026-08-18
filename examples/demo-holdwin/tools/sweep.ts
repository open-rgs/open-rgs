import { rect, countWhere } from "../../../packages/grid/src/index.js";
import { stackyFill } from "../../../packages/markov/src/index.js";
function mb(seed: number){let a=seed>>>0;return()=>{a=(a+0x6d2b79f5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
const SHAPE = rect(5,3); const N = 400_000;
console.log("COIN  E[coins]  P(>=6)      1 in");
for (const c of [5.5, 6.5, 7.5, 8.5, 9.5]) {
  const gen = stackyFill(SHAPE, { LOW:47, MID:25, HI:13, PREM:7, WILD:5, COIN:c }, 0.35);
  const next = mb(99);
  let trig = 0, total = 0;
  for (let i=0;i<N;i++){ const n = countWhere(gen(next), s => s === "COIN"); total += n; if (n>=6) trig++; }
  console.log(`${c.toFixed(1).padStart(4)}  ${(total/N).toFixed(3).padStart(8)}  ${(trig/N*100).toFixed(3).padStart(7)}%  ${trig?String(Math.round(N/trig)).padStart(6):"  never"}`);
}
