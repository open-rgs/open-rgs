// Lua math loader. Each math file is a standalone Lua module that returns
// a table with some subset of {play, open, step, close, is_terminal,
// autoclose, kind, name, version, rtp}.
//
// The loader instantiates one Lua VM per math file, exposes a small host
// surface (rng_next, log_debug), installs any LuaExtension passed in via
// options, and adapts the Lua table into a MathModule conforming to
// @open-rgs/contract.
//
// NOTE: Math is currency-blind. There is no `patch_balance` hook  - the
// orchestrator sends balance to the client as a separate response field,
// not via ops. Math returns ops; core forwards them as-is.

import { LuaFactory, type LuaEngine } from "wasmoon";
import { readFile } from "node:fs/promises";
import { createHash, webcrypto } from "node:crypto";
import { RGSError } from "@open-rgs/contract";
import type {
  SimpleMath, ComplexMath, MathModule,
  RoundOutcome, OpenOutcome, StepOutcome, CloseOutcome,
  CarryState, RoundState, SpinContext, PlayerAction, Op,
  LuaExtension, LuaVm,
  MathExpectations, MarkCollector, MathTarget,
} from "@open-rgs/contract";
import { log } from "./log.js";
import { createMarkCollector, noopMarkCollector } from "./marks.js";

const factory = new LuaFactory();

// In-VM PRNG for rngMode "seed-expand": xoshiro256++ (Lua 5.4 64-bit ints,
// which wrap mod 2^64) seeded by splitmix64 from a per-call seed. Bit-identical
// to the canonical algorithm (verified against a BigInt reference over multiple
// seeds), uniform, and ~8x cheaper per draw than a JS<->WASM crossing. The "++"
// output (rotl(s0+s3,23)+s0) is MULTIPLY-FREE  - critical, since 64-bit
// multiplies are slow in interpreted Lua (the "**" variant was ~30x slower and
// made seed-expand a net loss). State (s0..s3) + rotl are chunk-locals captured
// as upvalues, unreachable by the sandboxed math; the global names are nil'd
// after wiring (host.rng_next keeps the function value). DO NOT change the
// arithmetic without re-verifying against the reference  - a biased PRNG biases
// RTP.
const SEED_EXPAND_LUA = `
  local s0, s1, s2, s3 = 0, 0, 0, 0
  local function rotl(x, k) return (x << k) | (x >> (64 - k)) end
  function __open_rgs_xoshiro_reseed(hi, lo)
    local st = (math.floor(hi) << 32) | math.floor(lo)
    local function sm()
      st = st + 0x9e3779b97f4a7c15
      local z = st
      z = (z ~ (z >> 30)) * 0xbf58476d1ce4e5b9
      z = (z ~ (z >> 27)) * 0x94d049bb133111eb
      return z ~ (z >> 31)
    end
    s0 = sm(); s1 = sm(); s2 = sm(); s3 = sm()
  end
  function __open_rgs_xoshiro_next()
    local result = rotl((s0 + s3) & 0xFFFFFFFFFFFFFFFF, 23) + s0
    local t = s1 << 17
    s2 = s2 ~ s0; s3 = s3 ~ s1; s1 = s1 ~ s2; s0 = s0 ~ s3; s2 = s2 ~ t; s3 = rotl(s3, 45)
    return (result >> 11) / 9007199254740992.0
  end
`;

interface LuaApi {
  kind?: "simple" | "complex";
  name?: string;
  version?: string;
  rtp?: number;
  expected?: unknown;          // raw lua table; adapted to MathExpectations

  play?: (prev: string | undefined, ctx: unknown) => unknown;
  open?: (prev: string | undefined, ctx: unknown) => unknown;
  step?: (state: string, action: unknown) => unknown;
  close?: (state: string) => unknown;
  is_terminal?: (state: string) => boolean;
  autoclose?: (state: string) => unknown;
}

export interface LoadLuaMathOptions {
  /** Random source for the math VM  - `() => number` in `[0, 1)`.
   *
   *  Determines outcomes, so it must be cryptographically secure. When
   *  omitted, open-rgs defaults to {@link cryptoRng}  - the system CSPRNG via
   *  WebCrypto (BoringSSL/OpenSSL, the same source Bun's `crypto` uses)  -
   *  NEVER `Math.random` (V8 xorshift128+, non-cryptographic and unseedable).
   *  Under `NODE_ENV=production` with no `rng`, `loadLuaMath` FAILS CLOSED
   *  (throws) so the operator picks its certified/approved source consciously;
   *  pass `{ rng: cryptoRng }` to use the system CSPRNG in production. A
   *  jurisdiction-certified RGS injects its approved (auditable, seed-commit)
   *  RNG here. */
  rng?: () => number;
  /** Escape hatch: permit booting WITHOUT an injected rng under
   *  `NODE_ENV=production` (the secure {@link cryptoRng} default is then used),
   *  and permit a tagged simulator-only PRNG in production. Defaults to
   *  `false`  - production fails closed without an explicit rng choice. For
   *  offline, non-real-money tooling only. */
  allowInsecureRng?: boolean;
  /** Per-call wall-clock budget (ms) for every math entry point
   *  (play/open/step/close/autoclose) and for load-time evaluation. wasmoon
   *  runs Lua synchronously on the event loop, so a runaway math
   *  (`while true do end`) would block the whole server; a Lua instruction
   *  hook aborts the call with `MATH_TIMEOUT` once the budget is exceeded.
   *  Default 1000. Set `0` to disable the watchdog (e.g. heavy simulation
   *  runs that trust the math). */
  timeoutMs?: number;
  /** Extensions installed into the VM before evaluating the math file.
   *  See {@link LuaExtension}. Registration order is significant: it
   *  determines the order transforms run, and the order host() functions
   *  shadow same-named lua keys. */
  extensions?: readonly LuaExtension[];
  /** Enable real mark collection. host.mark.* always exists; with
   *  marks:false (default) the calls are no-ops with ~zero cost. The
   *  simulator passes true to drive deviation reports. */
  marks?: boolean;
  /** How randomness reaches the math. Default `"per-draw"`: every
   *  `host.rng_next()` calls the injected `rng` directly  - one JS<->WASM
   *  crossing per draw (~630 ns each, measured).
   *
   *  `"seed-expand"`: draw ONE seed per math call from `rng` and expand it
   *  IN-VM with xoshiro256++ (seeded by splitmix64), so the math draws with
   *  zero per-draw crossings  - only the per-call reseed crosses. An in-VM
   *  draw is ~8x cheaper than a crossing, so this is a big win for draw-heavy
   *  math (dozens of draws/spin) on both the server and the simulator; no
   *  benefit (slightly more `rng` use) for ~1-draw math. Each entry-point call
   *  is reseeded independently and the generator is hidden from the math (it
   *  cannot reseed or peek).
   *
   *  CERT NOTE: under `"seed-expand"` the xoshiro expansion enters the
   *  outcome-determination path, so it must be evaluated as part of the RNG
   *  (re-certify before real-money use). A call is fully reconstructable from
   *  its seed. Default stays `"per-draw"`. */
  rngMode?: "per-draw" | "seed-expand";
}

/** Cryptographically-secure default RNG, backed by the system CSPRNG (Bun /
 *  Node WebCrypto -> BoringSSL/OpenSSL `RAND_bytes`, the same source Bun's
 *  `crypto` uses). Returns a uniform 53-bit float in `[0, 1)`. This is
 *  open-rgs's secure default for outcome determination  - unpredictable and
 *  unseedable, unlike `Math.random` (V8 xorshift128+).
 *
 *  It is a CSPRNG, NOT necessarily a *certified/auditable* RNG (no seed-commit
 *  or consumed-value log). Jurisdictions that mandate a certified source should
 *  inject their approved RNG via `loadLuaMath({ rng })`. */
export function cryptoRng(): number {
  const u = new Uint32Array(2);
  webcrypto.getRandomValues(u);
  // 53 random bits: all 32 of u[0] shifted up by 21, plus the top 21 of u[1].
  return (u[0]! * 0x20_0000 + (u[1]! >>> 11)) / 0x20_0000_0000_0000;
}

/** Resolve the math RNG. Defaults to the secure system CSPRNG ({@link
 *  cryptoRng})  - never `Math.random`. In production with no injected rng we
 *  fail closed (throw) so the operator chooses its certified/approved source
 *  consciously rather than us picking silently. */
function resolveRng(path: string, opts: LoadLuaMathOptions | undefined): () => number {
  const isProduction = process.env["NODE_ENV"] === "production";
  if (opts?.rng) {
    // Reject a simulator-only PRNG (e.g. mulberry32) for production outcome
    // determination  - it's reproducible and predictable (see audit H8).
    const tagged = (opts.rng as { __insecureSimulatorRng?: boolean }).__insecureSimulatorRng;
    if (isProduction && tagged && !opts.allowInsecureRng) {
      throw new Error(
        `loadLuaMath(${path}): the injected rng is a simulator-only PRNG ` +
        `(mulberry32 or similar)  - non-cryptographic and predictable, not for ` +
        `real-money outcome determination. Inject a certified CSPRNG, or pass ` +
        `{ allowInsecureRng: true } for non-real-money tooling only.`,
      );
    }
    return opts.rng;
  }
  if (isProduction && !opts?.allowInsecureRng) {
    throw new Error(
      `loadLuaMath(${path}): no rng provided. A production RGS must choose its ` +
      `outcome RNG consciously  - pass { rng: cryptoRng } to use the secure system ` +
      `CSPRNG (WebCrypto -> BoringSSL), or inject a certified/approved source. ` +
      `(We refuse to default silently in production, even to a secure CSPRNG; ` +
      `outside production cryptoRng is the default. { allowInsecureRng: true } ` +
      `permits the default for non-real-money tooling.)`,
    );
  }
  log.warn("loadLuaMath: no rng injected  - defaulting to the system CSPRNG " +
    "(cryptoRng / WebCrypto -> BoringSSL). Secure and unpredictable, but not a " +
    "certified/auditable source  - inject your approved RNG for real-money " +
    "certification.", {
    "event.category": "process",
    "event.action": "rng_crypto_default",
    "math.path": path,
  });
  return cryptoRng;
}

/** Load a Lua math file and adapt it to MathModule. */
export async function loadLuaMath(path: string, opts?: LoadLuaMathOptions): Promise<MathModule> {
  const rng = resolveRng(path, opts);
  const source = await readFile(path, "utf8");
  const lua: LuaEngine = await factory.createEngine();

  // Hash the *original* source (pre-transform). This proves which math
  // file was loaded, regardless of what extensions did to it during eval.
  const contentHash = createHash("sha256").update(source).digest("hex");

  // --- Execution watchdog (see timeoutMs) --------------------------------
  // wasmoon runs Lua synchronously on the event loop, so a runaway math
  // (`while true do end`) would block the whole server and no JS timer could
  // interrupt it. The only lever is a Lua instruction (count) hook that aborts
  // once we pass a wall-clock deadline. The hook applies to the thread it is
  // armed ON, and wasmoon runs each JS->Lua bridge call on its own thread - so
  // we arm the hook INSIDE the call: the guarded dispatcher does `sethook(...)`
  // as its first act, then pcall's the math. That makes the watchdog apply on a
  // plain bridge call, so the math can be invoked through the JS function bridge
  // (synchronous, no per-call work) instead of recompiling a fresh `doString`
  // chunk every call. (Arming the hook beforehand, on a different thread, does
  // NOT carry to the call's thread - verified - which is why it's armed inside.)
  const timeoutMs = opts?.timeoutMs ?? 1000;
  const watchdog = timeoutMs > 0;
  let deadline = Infinity;
  // Bridge handle to the guarded dispatcher, captured once after it's defined
  // (watchdog on). Calling it runs the math under the abort hook without
  // recompiling a chunk per call. Stays undefined when the watchdog is off.
  let invokeNamed: ((name: string, ...args: unknown[]) => unknown) | undefined;

  // Seed-expand RNG mode (opt-in, see LoadLuaMathOptions.rngMode). Per math
  // call we draw one 64-bit seed from the resolved `rng` (two u32 halves) and
  // reseed the in-VM PRNG; the math then draws with no per-draw crossing.
  // `reseed` is the bridge handle, captured once the generator is installed.
  const seedExpand = opts?.rngMode === "seed-expand";
  const rngU32 = (): number => Math.floor(rng() * 0x1_0000_0000);
  let reseed: ((hi: number, lo: number) => void) | undefined;
  const asTimeout = (e: unknown): RGSError | null =>
    e instanceof Error && e.message.includes("MATH_TIMEOUT")
      ? new RGSError("MATH_TIMEOUT", `math exceeded its ${timeoutMs}ms execution budget`)
      : null;

  /** Invoke a math entry point. With the watchdog off, call it directly
   *  (synchronous, zero overhead  - for trusted bulk simulation). With it on,
   *  call the guarded dispatcher through the JS bridge: it arms the count hook
   *  on the call's own thread before pcall-ing the math, so the abort hook
   *  applies WITHOUT recompiling a fresh chunk per call (the old per-call
   *  `doString` did, which dominated the cost of a small math). The bridge call
   *  is synchronous for synchronous Lua, so no Promise / microtask is created. */
  function invoke(fnName: string, args: unknown[]): unknown | Promise<unknown> {
    // Reseed the in-VM PRNG from `rng` once per call (one crossing), regardless
    // of how many draws the math makes. Covers both paths below.
    if (seedExpand) reseed!(rngU32(), rngU32());
    if (!watchdog) {
      return (api as Record<string, (...a: unknown[]) => unknown>)[fnName]!(...args);
    }
    deadline = performance.now() + timeoutMs;
    try {
      return invokeNamed!(fnName, ...args);
    } catch (e) {
      throw asTimeout(e) ?? e;
    } finally {
      deadline = Infinity;
    }
  }

  /** Apply a Lua->TS adapter to an invoke() result, awaiting if guarded. */
  function mapResult<T>(raw: unknown | Promise<unknown>, adapt: (r: unknown) => T): T | Promise<T> {
    return raw instanceof Promise ? raw.then(adapt) : adapt(raw);
  }

  const extensions = opts?.extensions ?? [];

  // Compose transforms once. Identity if no extension provides any.
  const applyTransforms = (src: string, p: string): string => {
    let out = src;
    for (const ext of extensions) {
      if (ext.transform) {
        try {
          out = ext.transform(out, p);
        } catch (e) {
          throw new Error(`Extension '${ext.name}' transform failed on ${p}: ${String(e)}`);
        }
      }
    }
    return out;
  };

  // Mark collector  - real if opted in, no-op otherwise. Always exposed
  // as host.mark so math files are portable between sim and server.
  const marks: MarkCollector = opts?.marks ? createMarkCollector() : noopMarkCollector();

  // Host imports exposed to the math. NB: no balance / bet / currency
  // helpers  - by design. Math sees ONLY randomness, a logger, and
  // (optionally) annotation marks.
  //
  // `host` is built as a PURE LUA TABLE, not a JS object handed to
  // global.set. A JS-backed table is a proxy whose every field access goes
  // through a `__index` metamethod that crosses into JS  - and `host.rng_next`
  // is read once per draw, so that crossing (~4.3 us per access, measured)
  // dominates draw-heavy math. Referencing the JS hooks from a plain Lua table
  // makes `host.rng_next` a cheap Lua index (~6.5x faster on the RNG hot path);
  // only the underlying hook *call* still crosses. We set the raw hooks under
  // private globals, copy them into the Lua `host`, then drop the globals so
  // the sandboxed math reaches them only through `host.*`.
  lua.global.set("__rgs_rng",             () => rng());
  lua.global.set("__rgs_log",             (msg: string) => log.debug(`[lua:${path}] ${msg}`));
  lua.global.set("__rgs_mark_count",      (name: string) => marks.count(name));
  lua.global.set("__rgs_mark_observe",    (name: string, value: number) => marks.observe(name, Number(value)));
  lua.global.set("__rgs_mark_tag",        (name: string) => marks.tag(name));
  lua.global.set("__rgs_mark_contribute", (name: string, multiplier: number) => marks.contribute(name, Number(multiplier)));
  await lua.doString(`
    host = {
      rng_next  = __rgs_rng,
      log_debug = __rgs_log,
      mark = {
        count = __rgs_mark_count, observe = __rgs_mark_observe,
        tag   = __rgs_mark_tag,   contribute = __rgs_mark_contribute,
      },
    }
    __rgs_rng = nil; __rgs_log = nil
    __rgs_mark_count = nil; __rgs_mark_observe = nil
    __rgs_mark_tag = nil; __rgs_mark_contribute = nil
  `);

  // Seed-expand mode: install the in-VM PRNG and repoint host.rng_next at it,
  // so the math draws without crossing into JS per draw (invoke() reseeds it
  // from `rng` once per call). The generator is then hidden from the (untrusted)
  // math  - it cannot reseed or peek  - while host.rng_next keeps working
  // because the table holds the function value, not the global name. Repointed
  // BEFORE the math.random override + sandbox lockdown below, which read
  // host.rng_next dynamically, so they pick it up.
  if (seedExpand) {
    await lua.doString(SEED_EXPAND_LUA);
    await lua.doString(`host.rng_next = __open_rgs_xoshiro_next`);
    reseed = lua.global.get("__open_rgs_xoshiro_reseed") as (hi: number, lo: number) => void;
    await lua.doString(`__open_rgs_xoshiro_reseed = nil; __open_rgs_xoshiro_next = nil`);
    reseed(rngU32(), rngU32()); // seed before any load-time draw (all-zero state -> all zeros)
  }

  // The minimal VM handle extensions get for VM-level operations.
  const vm: LuaVm = {
    setGlobal: (name: string, value: unknown) => lua.global.set(name, value),
  };

  // Install each extension: evaluate its lua source (if any), merge its
  // host() table, register the combined module in a registry that the
  // shimmed require() consults.
  const registry: Record<string, unknown> = {};
  for (const ext of extensions) {
    if (!/^[A-Za-z_][\w-]*$/.test(ext.name)) {
      throw new Error(`Extension name '${ext.name}' is not a valid Lua module identifier`);
    }

    let ns: Record<string, unknown> = {};

    if (ext.lua) {
      const transformed = applyTransforms(ext.lua, `<extension:${ext.name}>`);
      // Evaluate the extension source as a closure that returns its module
      // table. Store under a private slot so we can pull it back into JS.
      const slot = `__open_rgs_ext_${ext.name.replace(/-/g, "_")}`;
      await lua.doString(`${slot} = (function() ${transformed} end)()`);
      const got = lua.global.get(slot) as Record<string, unknown> | undefined;
      if (got && typeof got === "object") {
        // Lua-table -> JS object: wasmoon hands us a proxy-ish object we
        // can copy keys from. Stringly-keyed only (we don't expect
        // integer-keyed extension modules).
        for (const k of Object.keys(got)) ns[k] = got[k];
      } else {
        throw new Error(`Extension '${ext.name}' lua source did not return a table`);
      }
    }

    if (ext.host) {
      try {
        const native = ext.host(vm);
        ns = { ...ns, ...native };
      } catch (e) {
        throw new Error(`Extension '${ext.name}' host() initialiser failed: ${String(e)}`);
      }
    }

    registry[ext.name] = ns;
    log.debug(`[lua:${path}] extension installed: ${ext.name}@${ext.version}`);
  }

  // Expose the registry and override require() to consult it. We do NOT
  // chain to Lua's default package.loaders  - math should depend only on
  // explicitly registered extensions, never on the host filesystem.
  lua.global.set("__open_rgs_ext_registry", registry);
  await lua.doString(`
    local registry = __open_rgs_ext_registry or {}
    function require(name)
      local m = registry[name]
      if m == nil then
        error("open-rgs: extension '" .. tostring(name) .. "' not registered (did you pass it to loadLuaMath?)", 2)
      end
      return m
    end
  `);

  // Define the guarded invoker BEFORE the sandbox nils `debug`. It arms a
  // Lua count hook on the current thread, runs the math fn, disarms  - the
  // hook fires every N instructions and aborts once we pass the per-call
  // deadline. It must be CALLED FROM a doString chunk (see invoke()), not
  // via the JS function bridge, for the hook to apply. `sethook`, the hook,
  // and the deadline check are captured as upvalues then hidden, so the
  // (sandboxed) math cannot reach or disable the watchdog.
  if (watchdog) {
    lua.global.set("__open_rgs_deadline_check", () => performance.now() > deadline);
    await lua.doString(`
      do
        local sethook = debug.sethook
        local check = __open_rgs_deadline_check
        local function hook()
          if check() then error("MATH_TIMEOUT: math exceeded its time budget", 0) end
        end
        -- Used at LOAD time only: module construction runs inside a doString
        -- (below), and this guards that one evaluation.
        function __open_rgs_invoke(fn, a, b)
          sethook(hook, "", 100000)
          local ok, res = pcall(fn, a, b)
          sethook()
          if not ok then error(res, 0) end
          return res
        end
        -- Used PER CALL: looked up by name and invoked through the JS bridge
        -- (see invoke()), so no chunk is recompiled per call. sethook is armed
        -- HERE, inside the bridged call, which is what makes the hook apply on
        -- wasmoon's call thread - arming it beforehand does not carry.
        function __open_rgs_invoke_named(name, ...)
          sethook(hook, "", 100000)
          local ok, res = pcall(__open_rgs_math[name], ...)
          sethook()
          if not ok then error(res, 0) end
          return res
        end
      end
      __open_rgs_deadline_check = nil
    `);
    invokeNamed = lua.global.get("__open_rgs_invoke_named") as (name: string, ...args: unknown[]) => unknown;
  }

  // Lock down the global environment before the (untrusted) math file runs.
  // Math is a trust boundary: it must see ONLY host.rng_next for entropy and
  // must not reach the OS, the filesystem, dynamic code loading, the debug
  // library (which can re-introspect/patch any function), or non-deterministic
  // clocks. Overriding require() alone (above) left all of these reachable.
  // Extensions are operator-configured and already ran their install step,
  // so this guards the math file itself. NB: nil-ing Lua's `load`/`loadfile`
  // does not affect our own evaluation, which goes through wasmoon's
  // host-side loader (`lua.doString`), not the Lua globals.
  await lua.doString(`
    os = nil
    io = nil
    debug = nil
    load = nil
    loadstring = nil
    loadfile = nil
    dofile = nil
    package = nil
    collectgarbage = nil
    -- Route Lua's built-in randomness through the injected host RNG so a
    -- math file cannot silently bypass the auditable seam via math.random /
    -- math.randomseed. Preserve the three Lua call signatures.
    if math then
      math.random = function(m, n)
        local r = host.rng_next()        -- [0, 1) from the injected RNG
        if m == nil then return r end
        if n == nil then n = m; m = 1 end
        return m + math.floor(r * (n - m + 1))
      end
      math.randomseed = function() end   -- no-op: seeding is the host's job
    end
  `);

  // Apply transforms to the user's math source and evaluate. With the
  // watchdog on, run module construction through the guarded invoker too  -
  // a top-level `while true` at load time is a DoS as well.
  const transformedSource = applyTransforms(source, path);
  if (watchdog) {
    deadline = performance.now() + timeoutMs;
    try {
      await lua.doString(`__open_rgs_math = __open_rgs_invoke(function() ${transformedSource} end)`);
    } catch (e) {
      throw asTimeout(e) ?? e;
    } finally {
      deadline = Infinity;
    }
  } else {
    await lua.doString(`__open_rgs_math = (function() ${transformedSource} end)()`);
  }
  const api = lua.global.get("__open_rgs_math") as LuaApi | undefined;
  if (!api || typeof api !== "object") {
    throw new Error(`Lua math at ${path} did not return a table`);
  }

  const kind = api.kind === "complex" ? "complex" : "simple";
  const name = api.name ?? path;
  const version = api.version ?? "0.0.0";
  // A math that omits `rtp` defaults to 0, which makes the boot-time
  // declaredRtp-vs-math.rtp check look like a mismatch. Warn so it's clear
  // the rtp is unset, not wrong. (L8)
  if (api.rtp === undefined) {
    log.warn("Lua math declared no rtp  - defaulting to 0 (the boot RTP check will read as mismatched)", {
      "event.category": "process",
      "event.action": "math_rtp_unset",
      "math.path": path,
      "math.name": name,
    });
  }
  const rtp = api.rtp ?? 0;
  const expected = adaptExpectations(api.expected);

  if (kind === "simple") {
    if (typeof api.play !== "function") {
      throw new Error(`Lua math at ${path}: kind='simple' requires play()`);
    }
    const m: SimpleMath = {
      kind: "simple",
      name, version, rtp,
      contentHash,
      ...(expected ? { expected } : {}),
      marks,
      play(prev: CarryState | undefined, ctx: SpinContext): RoundOutcome | Promise<RoundOutcome> {
        return mapResult(invoke("play", [prev, ctx]), adaptRoundOutcome);
      },
    };
    return m;
  }

  for (const fn of ["open", "step", "close", "is_terminal"] as const) {
    if (typeof api[fn] !== "function") {
      throw new Error(`Lua math at ${path}: kind='complex' requires ${fn}()`);
    }
  }

  const m: ComplexMath = {
    kind: "complex",
    name, version, rtp,
    contentHash,
    ...(expected ? { expected } : {}),
    marks,
    open(prev: CarryState | undefined, ctx: SpinContext): OpenOutcome | Promise<OpenOutcome> {
      return mapResult(invoke("open", [prev, ctx]), adaptOpenOutcome);
    },
    step(state: RoundState, action: PlayerAction): StepOutcome | Promise<StepOutcome> {
      return mapResult(invoke("step", [state, action]), adaptStepOutcome);
    },
    isTerminal(state: RoundState): boolean | Promise<boolean> {
      return mapResult(invoke("is_terminal", [state]), (r) => Boolean(r));
    },
    close(state: RoundState): CloseOutcome | Promise<CloseOutcome> {
      return mapResult(invoke("close", [state]), adaptCloseOutcome);
    },
    autoclose: typeof api.autoclose === "function"
      ? (state: RoundState) => mapResult(invoke("autoclose", [state]), adaptCloseOutcome)
      : undefined,
  };
  return m;
}

function adaptExpectations(raw: unknown): MathExpectations | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const out: MathExpectations = {};

  const hr = adaptTarget(o["hit_rate"]) ?? adaptTarget(o["hitRate"]);
  if (hr) out.hitRate = hr;

  out.rate            = adaptTargetMap(o["rate"]);
  out.rtpContribution = adaptTargetMap(o["rtp_contribution"]) ?? adaptTargetMap(o["rtpContribution"]);
  out.tagShare        = adaptTargetMap(o["tag_share"]) ?? adaptTargetMap(o["tagShare"]);

  // Strip empty maps.
  if (out.rate            && Object.keys(out.rate).length === 0)            delete out.rate;
  if (out.rtpContribution && Object.keys(out.rtpContribution).length === 0) delete out.rtpContribution;
  if (out.tagShare        && Object.keys(out.tagShare).length === 0)        delete out.tagShare;

  return Object.keys(out).length > 0 ? out : undefined;
}

function adaptTarget(raw: unknown): MathTarget | undefined {
  if (raw == null) return undefined;
  if (typeof raw === "number") return { target: raw };
  if (typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o["target"] !== "number") return undefined;
  const t: MathTarget = { target: Number(o["target"]) };
  if (typeof o["tolerance"] === "number") t.tolerance = Number(o["tolerance"]);
  return t;
}

function adaptTargetMap(raw: unknown): Record<string, MathTarget> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, MathTarget> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const t = adaptTarget(v);
    if (t) out[k] = t;
  }
  return out;
}

// --- Lua -> TS adapters ------------------------------------------------------
// Lua tables come back as objects. Arrays come back as 1-indexed objects
// or proper arrays depending on shape; we normalise both.

function asArray<T = unknown>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (v && typeof v === "object") {
    // Lua 1-indexed table. Collect numeric keys in order.
    const obj = v as Record<string, unknown>;
    const out: T[] = [];
    for (let i = 1; ; i++) {
      const key = String(i);
      if (!(key in obj)) break;
      out.push(obj[key] as T);
    }
    if (out.length > 0) return out;
  }
  return [];
}

function adaptRoundOutcome(raw: unknown): RoundOutcome {
  const o = raw as Record<string, unknown>;
  return {
    multiplier: Number(o["multiplier"] ?? 0),
    ops: asArray<Op>(o["ops"]),
    type: String(o["type"] ?? "spin"),
    carry: o["carry"] === undefined ? undefined : String(o["carry"]),
    nextMode: o["next_mode"] === undefined ? undefined : String(o["next_mode"]),
  };
}

function adaptOpenOutcome(raw: unknown): OpenOutcome {
  const o = raw as Record<string, unknown>;
  return {
    state: String(o["state"] ?? ""),
    ops: asArray<Op>(o["ops"]),
    awaiting: adaptAwaiting(o["awaiting"]),
  };
}

function adaptStepOutcome(raw: unknown): StepOutcome {
  const o = raw as Record<string, unknown>;
  return {
    state: String(o["state"] ?? ""),
    ops: asArray<Op>(o["ops"]),
    awaiting: adaptAwaiting(o["awaiting"]),
  };
}

function adaptCloseOutcome(raw: unknown): CloseOutcome {
  const o = raw as Record<string, unknown>;
  return {
    multiplier: Number(o["multiplier"] ?? 0),
    ops: asArray<Op>(o["ops"]),
    type: String(o["type"] ?? "close"),
    carry: o["carry"] === undefined ? undefined : String(o["carry"]),
    nextMode: o["next_mode"] === undefined ? undefined : String(o["next_mode"]),
  };
}

function adaptAwaiting(raw: unknown) {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  if (!o["type"]) return undefined;
  return {
    type: String(o["type"]),
    options: o["options"] === undefined ? undefined : asArray(o["options"]),
    deadline: o["deadline"] === undefined ? undefined : Number(o["deadline"]),
    prompt: o["prompt"] === undefined ? undefined : String(o["prompt"]),
  };
}
