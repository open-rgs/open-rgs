import createMath from "../src/math.js";
function mb(seed:number){let a=seed>>>0;return()=>{a=(a+0x6d2b79f5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
const N = Number(process.argv[2] ?? 1_000_000);
const m = createMath({ rng_next: mb(2024), log_debug: () => {} });
let sum=0,sumSq=0,hits=0,max=0,tumbles=0,trunc=0,capped=0,longest=0;
const t0=performance.now();
for(let i=0;i<N;i++){
  const o=m.play(); sum+=o.multiplier; sumSq+=o.multiplier*o.multiplier;
  if(o.multiplier>0)hits++; if(o.multiplier>max)max=o.multiplier;
  const ts=o.ops.filter((x:any)=>x.kind==="tumble").length; tumbles+=ts; if(ts>longest)longest=ts;
  if(o.ops.some((x:any)=>x.kind==="truncated"))trunc++;
  if(o.ops.some((x:any)=>x.kind==="maxWin"))capped++;
}
const ms=performance.now()-t0, mean=sum/N, v=sumSq/N-mean*mean;
console.log(`spins          ${N.toLocaleString()} in ${(ms/1000).toFixed(2)}s (${Math.round(N/(ms/1000)).toLocaleString()}/s)`);
console.log(`RTP            ${(mean*100).toFixed(2)}%  +/- ${(1.96*Math.sqrt(v/N)*100).toFixed(2)} (95% CI)`);
console.log(`volatility     ${Math.sqrt(v).toFixed(2)} sd/spin`);
console.log(`hit rate       ${(hits/N*100).toFixed(2)}%`);
console.log(`avg tumbles    ${(tumbles/N).toFixed(2)}   longest ${longest}`);
console.log(`truncated      ${trunc}   max-win hits ${capped}   top ${max.toFixed(1)}x`);
