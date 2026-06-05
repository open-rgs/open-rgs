// WASM math loader. Loads a `.wasm` math kernel conforming to the spec ABI
// (specs/03-math-runtime.md "WASM runtime details") and adapts it to a
// MathModule  - the orchestrator can't tell it from a Lua math.
//
// Why WASM math: native-speed execution with NO per-draw JS<->WASM proxy tax
// (the kernel calls the `host.rng_next` import directly), sandboxed by
// construction (it can only touch its own linear memory + the imports we pass),
// and a hashable artifact a regulator can certify. Source is typically Zig or
// Rust; see test/fixtures/wasm/play.zig for a reference kernel.
//
// I/O is MessagePack over linear memory: the host encodes inputs (prev, ctx)
// into wasm memory via `alloc`, calls the entry point with (ptr,len) pairs plus
// an output buffer, and msgpack-decodes the returned bytes. RNG resolution is
// shared with loadLuaMath (secure system CSPRNG by default; fail-closed in
// production).

import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { encode, decode } from "@msgpack/msgpack";
import { RGSError } from "@open-rgs/contract";
import type {
  SimpleMath, MathModule, CarryState, SpinContext, RoundOutcome,
} from "@open-rgs/contract";
import { log } from "./log.js";
import { resolveRng } from "./lua-math.js";
import { adaptRoundOutcome } from "./math-adapt.js";

export interface LoadWasmMathOptions {
  /** Outcome RNG, exposed to the kernel as the `host.rng_next` import. Same
   *  policy as loadLuaMath: defaults to the secure system CSPRNG (cryptoRng);
   *  production fails closed without an explicit choice. */
  rng?: () => number;
  /** Permit booting without an injected rng under NODE_ENV=production (uses the
   *  secure default), and a tagged simulator PRNG in prod. Tooling only. */
  allowInsecureRng?: boolean;
}

/** The exports a kernel must provide (simple math). */
interface WasmExports {
  memory: WebAssembly.Memory;
  kind(): number;
  name_ptr(): number; name_len(): number;
  version_ptr(): number; version_len(): number;
  rtp_x10000(): number;
  alloc(n: number): number;
  free(p: number): void;
  reset?(): void;
  play(prevP: number, prevL: number, ctxP: number, ctxL: number, outP: number, outMax: number): number;
}

/** Max bytes a kernel may write per outcome (must fit its linear-memory heap). */
const MAX_OUT = 1 << 16; // 64 KiB

/** Load a `.wasm` math kernel and adapt it to MathModule. */
export async function loadWasmMath(path: string, opts?: LoadWasmMathOptions): Promise<MathModule> {
  const rng = resolveRng(path, opts, "loadWasmMath");
  const bytes = await readFile(path);
  // Hash the artifact  - proves which kernel produced an outcome (audit log).
  const contentHash = createHash("sha256").update(bytes).digest("hex");

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

  if (kind === "complex") {
    // Complex kernels must msgpack-DECODE state/action in-kernel and expose
    // open/step/close/is_terminal; not wired yet. Use a simple kernel, or
    // loadLuaMath for complex rounds. (Tracking: spec 03 WASM complex ABI.)
    throw new RGSError("INTERNAL_ERROR",
      `loadWasmMath(${path}): complex WASM math (kind=1) is not yet supported  - ` +
      `use a simple kernel or loadLuaMath for complex rounds.`);
  }
  if (typeof ex.play !== "function") {
    throw new Error(`loadWasmMath(${path}): kind='simple' requires a 'play' export`);
  }

  const writeMem = (ptr: number, buf: Uint8Array): void => {
    new Uint8Array(ex.memory.buffer, ptr, buf.length).set(buf);
  };

  /** Encode (prev, ctx) into wasm memory, call play, decode the outcome. */
  function play(prev: CarryState | undefined, ctx: SpinContext): RoundOutcome {
    ex.reset?.(); // reset the kernel's bump allocator for this call
    const prevBuf = encode(prev ?? null);
    const ctxBuf = encode(ctx ?? null);
    const prevP = ex.alloc(prevBuf.length); writeMem(prevP, prevBuf);
    const ctxP = ex.alloc(ctxBuf.length); writeMem(ctxP, ctxBuf);
    const outP = ex.alloc(MAX_OUT);
    const outLen = ex.play(prevP, prevBuf.length, ctxP, ctxBuf.length, outP, MAX_OUT);
    if (!Number.isInteger(outLen) || outLen < 0 || outLen > MAX_OUT) {
      throw new RGSError("INTERNAL_ERROR", `loadWasmMath(${path}): play returned invalid output length ${outLen}`);
    }
    // Copy out before any later memory growth can detach the buffer.
    const outBytes = new Uint8Array(ex.memory.buffer, outP, outLen).slice();
    return adaptRoundOutcome(decode(outBytes));
  }

  const m: SimpleMath = { kind: "simple", name, version, rtp, contentHash, play };
  return m;
}
