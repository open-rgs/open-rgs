// WASM math loader. Loads a `.wasm` math kernel conforming to the spec ABI
// (specs/03-math-runtime.md "WASM runtime details") and adapts it to a
// MathModule  - the orchestrator can't tell it from a Lua math. Supports both
// simple (single `play`) and complex (open / step / is_terminal / close /
// autoclose) kernels.
//
// Why WASM math: native-speed execution with NO per-draw JS<->WASM proxy tax
// (the kernel calls the `host.rng_next` import directly), sandboxed by
// construction (it can only touch its own linear memory + the imports we pass),
// and a hashable artifact a regulator can certify. Source is typically Zig or
// Rust; see test/fixtures/wasm/play.zig (simple) and complex.zig (complex).
//
// I/O is MessagePack over linear memory: the host encodes inputs into wasm
// memory via `alloc`, calls the entry point with (ptr,len) pairs plus an output
// buffer, and msgpack-decodes the returned bytes. RNG resolution is shared with
// loadLuaMath (secure system CSPRNG by default; fail-closed in production).
//
// COMPLEX STATE BOUNDARY. A complex round's `state` (contract `RoundState`) is
// an opaque STRING that core stores and threads back into step / is_terminal /
// close. A WASM kernel's state is raw bytes (its own layout), so this loader
// owns the boundary: the kernel emits `state` as a MessagePack `bin` and the
// loader base64-encodes it into the RoundState string; on the way back in it
// base64-decodes and writes the raw bytes to wasm memory. The kernel never sees
// base64 and core never sees bytes. (A kernel MAY emit `state` as a msgpack
// string instead - it is then passed through unchanged.)
//
// LIMITATION  - NO EXECUTION WATCHDOG (security/availability). Unlike the Lua
// loader, a running WASM call cannot be interrupted from JS, so a kernel that
// loops forever blocks the event loop (a DoS). loadWasmMath has no per-call
// timeout: treat these kernels as TRUSTED and bounded. createMathPool runs them
// on worker threads and FAILS THE ROUND closed (MATH_TIMEOUT) on a budget
// overrun - the portable guarantee - but it is not a portable no-DoS sandbox:
// whether worker.terminate() kills a tight-loop runaway is platform-dependent
// (yes on Linux, no on Bun+macOS in our testing), so a runaway thread may leak.
// A hard cross-platform kill needs process isolation (SIGKILL). Treat ALL WASM
// kernels as trusted/bounded regardless. loadWasmMath warns at load.

import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { encode, decode } from "@msgpack/msgpack";
import { RGSError } from "@open-rgs/contract";
import type {
  SimpleMath, ComplexMath, MathModule, CarryState, RoundState, SpinContext,
  RoundOutcome, OpenOutcome, StepOutcome, CloseOutcome, PlayerAction,
} from "@open-rgs/contract";
import { log } from "./log.js";
import { resolveRng } from "./lua-math.js";
import {
  adaptRoundOutcome, adaptOpenOutcome, adaptStepOutcome, adaptCloseOutcome,
} from "./math-adapt.js";

export interface LoadWasmMathOptions {
  /** Outcome RNG, exposed to the kernel as the `host.rng_next` import. Same
   *  policy as loadLuaMath: defaults to the secure system CSPRNG (cryptoRng);
   *  production fails closed without an explicit choice. */
  rng?: () => number;
  /** Permit booting without an injected rng under NODE_ENV=production (uses the
   *  secure default), and a tagged simulator PRNG in prod. Tooling only. */
  allowInsecureRng?: boolean;
}

/** Exports a kernel may provide. Simple kernels need `play`; complex kernels
 *  need open / step / is_terminal / close (autoclose optional). */
interface WasmExports {
  memory: WebAssembly.Memory;
  kind(): number;
  name_ptr(): number; name_len(): number;
  version_ptr(): number; version_len(): number;
  rtp_x10000(): number;
  alloc(n: number): number;
  free(p: number): void;
  reset?(): void;
  play?(prevP: number, prevL: number, ctxP: number, ctxL: number, outP: number, outMax: number): number;
  open?(prevP: number, prevL: number, ctxP: number, ctxL: number, outP: number, outMax: number): number;
  step?(stateP: number, stateL: number, actP: number, actL: number, outP: number, outMax: number): number;
  is_terminal?(stateP: number, stateL: number): number;
  close?(stateP: number, stateL: number, outP: number, outMax: number): number;
  autoclose?(stateP: number, stateL: number, outP: number, outMax: number): number;
}

/** Max bytes a kernel may write per outcome (must fit its linear-memory heap). */
const MAX_OUT = 1 << 16; // 64 KiB

/** Load a `.wasm` math kernel and adapt it to MathModule. */
export async function loadWasmMath(path: string, opts?: LoadWasmMathOptions): Promise<MathModule> {
  const rng = resolveRng(path, opts, "loadWasmMath");
  const bytes = await readFile(path);
  // Hash the artifact  - proves which kernel produced an outcome (audit log).
  const contentHash = createHash("sha256").update(bytes).digest("hex");

  // Visibility for the no-watchdog limitation (see file header): a runaway WASM
  // call cannot be interrupted from JS, so the kernel must be trusted/bounded.
  log.warn("loadWasmMath: WASM math runs without an execution watchdog  - a " +
    "runaway kernel blocks the event loop. Use only trusted, bounded kernels. " +
    "(createMathPool moves math off the I/O thread and fails the round on " +
    "timeout, but is not a portable no-DoS sandbox - keep kernels trusted.)", {
    "event.category": "process",
    "event.action": "wasm_math_no_watchdog",
    "math.path": path,
  });

  let ex!: WasmExports;
  const readStr = (ptr: number, len: number): string =>
    new TextDecoder().decode(new Uint8Array(ex.memory.buffer, ptr, len));

  const imports = {
    host: {
      rng_next: () => rng(),
      log_debug: (ptr: number, len: number) => { if (len > 0) log.debug(`[wasm:${path}] ${readStr(ptr, len)}`); },
    },
  };
  const { instance } = await WebAssembly.instantiate(bytes, imports);
  ex = instance.exports as unknown as WasmExports;

  for (const fn of ["memory", "kind", "name_ptr", "name_len", "version_ptr", "version_len", "rtp_x10000", "alloc"] as const) {
    if (ex[fn] === undefined) throw new Error(`loadWasmMath(${path}): kernel missing required export '${fn}'`);
  }

  const kind = ex.kind() === 1 ? "complex" : "simple";
  const name = readStr(ex.name_ptr(), ex.name_len());
  const version = readStr(ex.version_ptr(), ex.version_len());
  const rtp = ex.rtp_x10000() / 10000;

  const writeMem = (ptr: number, buf: Uint8Array): void => {
    new Uint8Array(ex.memory.buffer, ptr, buf.length).set(buf);
  };
  /** msgpack-encode a value into wasm memory; return [ptr, len]. */
  const putMsgpack = (val: unknown): [number, number] => {
    const buf = encode(val ?? null);
    const p = ex.alloc(buf.length); writeMem(p, buf);
    return [p, buf.length];
  };
  /** Write raw bytes (e.g. a base64-decoded RoundState) into wasm memory. */
  const putBytes = (b: Uint8Array): [number, number] => {
    const p = ex.alloc(b.length); writeMem(p, b);
    return [p, b.length];
  };
  /** Copy out + msgpack-decode an outcome the kernel wrote at outP. */
  const readOut = (outP: number, outLen: number): Record<string, unknown> => {
    if (!Number.isInteger(outLen) || outLen < 0 || outLen > MAX_OUT) {
      throw new RGSError("INTERNAL_ERROR", `loadWasmMath(${path}): entry returned invalid output length ${outLen}`);
    }
    // Copy before any later memory growth can detach the buffer.
    const out = new Uint8Array(ex.memory.buffer, outP, outLen).slice();
    return decode(out) as Record<string, unknown>;
  };

  if (kind === "simple") {
    if (typeof ex.play !== "function") {
      throw new Error(`loadWasmMath(${path}): kind='simple' requires a 'play' export`);
    }
    const play = (prev: CarryState | undefined, ctx: SpinContext): RoundOutcome => {
      ex.reset?.(); // reset the kernel's bump allocator for this call
      const [pp, pl] = putMsgpack(prev);
      const [cp, cl] = putMsgpack(ctx);
      const outP = ex.alloc(MAX_OUT);
      const n = ex.play!(pp, pl, cp, cl, outP, MAX_OUT);
      return adaptRoundOutcome(readOut(outP, n));
    };
    return { kind: "simple", name, version, rtp, contentHash, play } satisfies SimpleMath;
  }

  // --- complex ---
  for (const fn of ["open", "step", "is_terminal", "close"] as const) {
    if (typeof ex[fn] !== "function") {
      throw new Error(`loadWasmMath(${path}): kind='complex' requires a '${fn}' export`);
    }
  }

  // The state boundary (see file header): kernel emits `state` as msgpack bin
  // (raw bytes); core wants an opaque string. base64 bridges the two. A kernel
  // that emits a plain string state is passed through unchanged.
  const stateOut = (raw: Record<string, unknown>): Record<string, unknown> => {
    const s = raw["state"];
    if (s instanceof Uint8Array) raw["state"] = Buffer.from(s).toString("base64");
    return raw;
  };
  const stateIn = (state: RoundState): Uint8Array => Uint8Array.from(Buffer.from(state, "base64"));

  const open = (prev: CarryState | undefined, ctx: SpinContext): OpenOutcome => {
    ex.reset?.();
    const [pp, pl] = putMsgpack(prev);
    const [cp, cl] = putMsgpack(ctx);
    const outP = ex.alloc(MAX_OUT);
    const n = ex.open!(pp, pl, cp, cl, outP, MAX_OUT);
    return adaptOpenOutcome(stateOut(readOut(outP, n)));
  };
  const step = (state: RoundState, action: PlayerAction): StepOutcome => {
    ex.reset?.();
    const [sp, sl] = putBytes(stateIn(state));
    const [ap, al] = putMsgpack(action);
    const outP = ex.alloc(MAX_OUT);
    const n = ex.step!(sp, sl, ap, al, outP, MAX_OUT);
    return adaptStepOutcome(stateOut(readOut(outP, n)));
  };
  const isTerminal = (state: RoundState): boolean => {
    ex.reset?.();
    const [sp, sl] = putBytes(stateIn(state));
    return ex.is_terminal!(sp, sl) === 1;
  };
  const close = (state: RoundState): CloseOutcome => {
    ex.reset?.();
    const [sp, sl] = putBytes(stateIn(state));
    const outP = ex.alloc(MAX_OUT);
    const n = ex.close!(sp, sl, outP, MAX_OUT);
    return adaptCloseOutcome(readOut(outP, n));
  };
  const autoclose = typeof ex.autoclose === "function"
    ? (state: RoundState): CloseOutcome => {
        ex.reset?.();
        const [sp, sl] = putBytes(stateIn(state));
        const outP = ex.alloc(MAX_OUT);
        const n = ex.autoclose!(sp, sl, outP, MAX_OUT);
        return adaptCloseOutcome(readOut(outP, n));
      }
    : undefined;

  return {
    kind: "complex", name, version, rtp, contentHash,
    open, step, isTerminal, close,
    ...(autoclose ? { autoclose } : {}),
  } satisfies ComplexMath;
}
