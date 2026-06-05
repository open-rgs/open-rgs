// Worker entry for the math pool (see math-pool.ts). Runs inside a Worker
// thread: loads a WASM math kernel and answers one play() at a time. The
// kernel uses a worker-local secure RNG (cryptoRng). If a kernel overruns its
// budget the pool fails the round (MATH_TIMEOUT) and replaces this worker - but
// note a tight-loop runaway thread can't be preempted and leaks (see
// math-pool.ts header); the pool is off-thread + round-fail, not a no-DoS box.

import { loadWasmMath } from "./wasm-math.js";
import { cryptoRng } from "./lua-math.js";
import type { SimpleMath, RoundOutcome } from "@open-rgs/contract";

// Worker-scope globals (declared so this file typechecks without a DOM/webworker lib).
declare function postMessage(message: unknown): void;
declare const self: { onmessage: ((e: { data: unknown }) => void) | null };

interface InitMsg { type: "init"; wasmPath: string }
interface PlayMsg { type: "play"; prev: string | undefined; ctx: unknown }

let math: SimpleMath | undefined;

self.onmessage = async (e: { data: unknown }): Promise<void> => {
  const msg = e.data as InitMsg | PlayMsg;
  if (msg.type === "init") {
    try {
      // Worker-local cryptoRng keeps the secure default with no cross-thread RNG
      // plumbing. (A custom certified source belongs to a future rngModule arg.)
      const m = await loadWasmMath(msg.wasmPath, { rng: cryptoRng }) as SimpleMath;
      math = m;
      postMessage({ type: "ready", meta: { name: m.name, version: m.version, rtp: m.rtp, contentHash: m.contentHash ?? "" } });
    } catch (err) {
      postMessage({ type: "init-error", message: err instanceof Error ? err.message : String(err) });
    }
    return;
  }
  if (msg.type === "play") {
    try {
      const outcome: RoundOutcome = await Promise.resolve(math!.play(msg.prev, msg.ctx as never));
      postMessage({ type: "result", outcome });
    } catch (err) {
      postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }
};
