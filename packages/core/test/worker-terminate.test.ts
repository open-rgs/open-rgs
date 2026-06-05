// Documents the platform reality createMathPool must live with: Bun's
// worker.terminate() does NOT preempt a tight SYNCHRONOUS loop. terminate only
// lands at a yield point, which `while(true){}` never reaches - so the runaway
// thread keeps executing after terminate() is called. This is exactly why the
// pool can fail the ROUND closed (reject + replace) but CANNOT guarantee no-DoS
// for untrusted WASM: the thread leaks. A true kill needs process isolation
// (SIGKILL on a subprocess, which DOES stop a tight loop - verified separately).
//
// This is a regression guard, not a wish: if a future Bun makes terminate()
// preempt sync loops, this assertion flips and we can upgrade the pool's
// guarantee. Until then, this is the honest contract.

import { expect, test } from "bun:test";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("worker.terminate() does NOT preempt a tight sync loop (so the pool is not no-DoS)", async () => {
  const sab = new SharedArrayBuffer(4);
  const counter = new Int32Array(sab);
  const url = new URL("./fixtures/spin-worker.ts", import.meta.url).href;
  const w = new Worker(url, { type: "module" });
  w.postMessage(sab);

  await sleep(80);
  expect(Atomics.load(counter, 0)).toBeGreaterThan(0); // it's really spinning

  w.terminate();
  await sleep(60);
  const afterKill = Atomics.load(counter, 0);
  await sleep(200);
  const later = Atomics.load(counter, 0);

  // The counter keeps climbing AFTER terminate() — the thread was not stopped.
  // (Were this a subprocess + SIGKILL, it would have died and `later === afterKill`.)
  expect(later).toBeGreaterThan(afterKill);
}, 10_000);
