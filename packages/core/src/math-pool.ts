// Math worker pool: runs WASM math kernels in a pool of Worker threads, off the
// orchestrator's I/O thread, with a per-call wall-clock budget.
//
// What it gives you:
//  - Performance: math runs on worker threads -> concurrency under load (the
//    I/O thread is never blocked by a spin).
//  - Round-level fail-closed: a call that overruns its budget REJECTS with
//    MATH_TIMEOUT (the round refuses to pay a hung/overrunning value, and the
//    connection isn't left waiting) and the worker is dropped + replaced, so the
//    pool stays usable.
//
// IMPORTANT - this is NOT a no-DoS sandbox for untrusted kernels. A tight
// synchronous runaway (`while (true) {}`) CANNOT be interrupted: Bun's
// `worker.terminate()` does not preempt a sync loop (it only lands at a yield
// point, which a tight loop never reaches - see worker-terminate.test.ts). We
// call terminate() best-effort, but a tight-loop runaway THREAD leaks (keeps a
// core busy) even though the round already failed closed. So treat WASM kernels
// as TRUSTED and bounded (same posture as bare loadWasmMath); the pool buys
// off-thread concurrency + round-level failure, not runaway-killing. True no-DoS
// needs process isolation (SIGKILL); not implemented here. (The Lua loader's
// in-VM debug.sethook watchdog DOES preempt a tight loop - that path is bounded.)
//
// Returns a `SimpleMath`-shaped, async math you can drop into a manifest mode;
// call `shutdown()` to tear the pool down. v1: simple (single `play`) WASM math.

import { RGSError } from "@open-rgs/contract";
import type { SimpleMath, RoundOutcome, CarryState, SpinContext } from "@open-rgs/contract";
import { log } from "./log.js";

export interface MathPoolOptions {
  /** Path to the `.wasm` kernel (loaded with a worker-local secure RNG). */
  wasmPath: string;
  /** Worker threads. Default 4. */
  size?: number;
  /** Per-call budget (ms). A call that overruns it kills its worker and fails
   *  with MATH_TIMEOUT; the worker is replaced. Default 1000. */
  timeoutMs?: number;
}

export interface MathPool extends SimpleMath {
  /** Terminate all workers and reject any in-flight / queued calls. */
  shutdown(): void;
}

interface Task {
  prev: CarryState | undefined;
  ctx: SpinContext;
  resolve: (o: RoundOutcome) => void;
  reject: (e: unknown) => void;
}
interface W {
  worker: Worker;
  busy: boolean;
  task: Task | null;
  timer: ReturnType<typeof setTimeout> | null;
}
interface PoolMeta { name: string; version: string; rtp: number; contentHash: string }

/** Create a worker-backed math pool for a WASM kernel. */
export async function createMathPool(opts: MathPoolOptions): Promise<MathPool> {
  const size = Math.max(1, opts.size ?? 4);
  const timeoutMs = opts.timeoutMs ?? 1000;
  const workerUrl = new URL("./math-worker.ts", import.meta.url).href;

  const workers: W[] = [];
  const queue: Task[] = [];
  let shuttingDown = false;

  function spawn(): Promise<{ w: W; meta: PoolMeta }> {
    return new Promise<{ w: W; meta: PoolMeta }>((ready, fail) => {
      const worker = new Worker(workerUrl, { type: "module" });
      const w: W = { worker, busy: false, task: null, timer: null };
      let inited = false;
      worker.onmessage = (e: { data: any }) => {
        const m = e.data;
        if (!inited) {
          if (m.type === "ready") { inited = true; ready({ w, meta: m.meta as PoolMeta }); }
          else if (m.type === "init-error") { fail(new Error(m.message)); }
          return;
        }
        if (m.type === "result" || m.type === "error") finishTask(w, m);
      };
      worker.onerror = (e: any) => {
        if (!inited) fail(new Error(`math worker failed to start: ${e?.message ?? e}`));
        else crashWorker(w);
      };
      worker.postMessage({ type: "init", wasmPath: opts.wasmPath });
    });
  }

  function assign(w: W, task: Task): void {
    w.busy = true;
    w.task = task;
    w.timer = setTimeout(() => timeoutWorker(w), timeoutMs);
    w.worker.postMessage({ type: "play", prev: task.prev, ctx: task.ctx });
  }
  function free(w: W): void {
    if (w.timer) { clearTimeout(w.timer); w.timer = null; }
    w.task = null;
    w.busy = false;
  }
  function pump(): void {
    if (shuttingDown) return;
    for (const w of workers) {
      if (queue.length === 0) break;
      if (!w.busy) assign(w, queue.shift()!);
    }
  }
  function finishTask(w: W, m: { type: string; outcome?: RoundOutcome; message?: string }): void {
    const task = w.task;
    free(w);
    if (task) {
      if (m.type === "result") task.resolve(m.outcome!);
      else task.reject(new RGSError("INTERNAL_ERROR", m.message ?? "math worker error"));
    }
    pump();
  }
  function remove(w: W): void {
    const i = workers.indexOf(w);
    if (i >= 0) workers.splice(i, 1);
  }
  function replace(): void {
    if (shuttingDown) return;
    spawn().then(({ w }) => { if (!shuttingDown) { workers.push(w); pump(); } else w.worker.terminate(); })
      .catch(err => log.warn("math pool: replacement worker failed to spawn", { "error.message": String(err) }));
  }
  function timeoutWorker(w: W): void {
    const task = w.task;
    w.timer = null; w.task = null; w.busy = false;
    log.warn("math worker exceeded its budget  - failing the round and replacing the worker", {
      "event.category": "process", "event.action": "math_worker_timeout", "timeout.ms": timeoutMs,
    });
    // Best-effort: terminate() reclaims a worker that's idle or yielding, but it
    // does NOT preempt a tight synchronous loop (that thread leaks - keeps a core
    // busy). The round still fails closed below regardless. See file header.
    try { w.worker.terminate(); } catch { /* already gone */ }
    remove(w);
    if (task) task.reject(new RGSError("MATH_TIMEOUT", `math exceeded its ${timeoutMs}ms execution budget`));
    replace();
  }
  function crashWorker(w: W): void {
    const task = w.task;
    free(w);
    remove(w);
    if (task) task.reject(new RGSError("INTERNAL_ERROR", "math worker crashed"));
    replace();
  }

  // Boot the pool. (Capture meta into a const so its non-null narrowing holds
  // through the closures below  - a `let` assigned inside the spawn callback
  // isn't narrowed by control-flow analysis.)
  const spawned = await Promise.all(Array.from({ length: size }, () => spawn()));
  workers.push(...spawned.map(s => s.w));
  const info = spawned[0]?.meta;
  if (!info) throw new Error("createMathPool: no worker reported metadata");

  function play(prev: CarryState | undefined, ctx: SpinContext): Promise<RoundOutcome> {
    return new Promise<RoundOutcome>((resolve, reject) => {
      if (shuttingDown) { reject(new RGSError("INTERNAL_ERROR", "math pool is shut down")); return; }
      const task: Task = { prev, ctx, resolve, reject };
      const idle = workers.find(w => !w.busy);
      if (idle) assign(idle, task); else queue.push(task);
    });
  }

  return {
    kind: "simple",
    name: info.name,
    version: info.version,
    rtp: info.rtp,
    contentHash: info.contentHash,
    play,
    shutdown(): void {
      shuttingDown = true;
      for (const t of queue) t.reject(new RGSError("INTERNAL_ERROR", "math pool shut down"));
      queue.length = 0;
      for (const w of workers) {
        if (w.timer) clearTimeout(w.timer);
        if (w.task) w.task.reject(new RGSError("INTERNAL_ERROR", "math pool shut down"));
        try { w.worker.terminate(); } catch { /* ignore */ }
      }
      workers.length = 0;
    },
  };
}
