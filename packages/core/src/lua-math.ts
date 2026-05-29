// Lua math loader. Each math file is a standalone Lua module that returns
// a table with some subset of {play, open, step, close, is_terminal,
// autoclose, kind, name, version, rtp}.
//
// The loader instantiates one Lua VM per math file, exposes a small host
// surface (rng_next, log_debug), installs any LuaExtension passed in via
// options, and adapts the Lua table into a MathModule conforming to
// @open-rgs/contract.
//
// NOTE: Math is currency-blind. There is no `patch_balance` hook — the
// orchestrator sends balance to the client as a separate response field,
// not via ops. Math returns ops; core forwards them as-is.

import { LuaFactory, type LuaEngine } from "wasmoon";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
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
  /** Random source for the math VM — `() => number` in `[0, 1)`.
   *
   *  REQUIRED for real-money use. A certified RGS must determine outcomes
   *  from an auditable CSPRNG; `Math.random` (V8 xorshift128+) is
   *  non-cryptographic, unseedable, and explicitly disallowed by GLI-19 /
   *  GLI-11. When omitted, `loadLuaMath` FAILS CLOSED under
   *  `NODE_ENV=production` (throws) rather than silently using `Math.random`.
   *  Outside production it falls back to `Math.random` with a loud warning,
   *  which is fine for simulation, local dev, and examples only. */
  rng?: () => number;
  /** Escape hatch: permit the `Math.random` fallback even under
   *  `NODE_ENV=production` (e.g. an offline, non-real-money tooling job).
   *  Defaults to `false` — production fails closed without an injected rng. */
  allowInsecureRng?: boolean;
  /** Extensions installed into the VM before evaluating the math file.
   *  See {@link LuaExtension}. Registration order is significant: it
   *  determines the order transforms run, and the order host() functions
   *  shadow same-named lua keys. */
  extensions?: readonly LuaExtension[];
  /** Enable real mark collection. host.mark.* always exists; with
   *  marks:false (default) the calls are no-ops with ~zero cost. The
   *  simulator passes true to drive deviation reports. */
  marks?: boolean;
}

/** Resolve the math RNG, failing closed in production when none is injected.
 *  A real-money RGS must not determine outcomes from `Math.random`; in
 *  production we refuse to boot without an explicit (certified) source. */
function resolveRng(path: string, opts: LoadLuaMathOptions | undefined): () => number {
  if (opts?.rng) return opts.rng;
  const isProduction = process.env["NODE_ENV"] === "production";
  if (isProduction && !opts?.allowInsecureRng) {
    throw new Error(
      `loadLuaMath(${path}): no rng provided. A production RGS must inject a ` +
      `certified CSPRNG for outcome determination — refusing to fall back to ` +
      `Math.random (non-auditable, GLI-19/GLI-11 disallowed). Pass { rng } or, ` +
      `for non-real-money tooling only, { allowInsecureRng: true }.`,
    );
  }
  log.warn("loadLuaMath: no rng injected — falling back to Math.random. " +
    "NOT auditable; do not use for real-money play.", {
    "event.category": "process",
    "event.action": "rng_insecure_fallback",
    "math.path": path,
  });
  return Math.random;
}

/** Load a Lua math file and adapt it to MathModule. */
export async function loadLuaMath(path: string, opts?: LoadLuaMathOptions): Promise<MathModule> {
  const rng = resolveRng(path, opts);
  const source = await readFile(path, "utf8");
  const lua: LuaEngine = await factory.createEngine();

  // Hash the *original* source (pre-transform). This proves which math
  // file was loaded, regardless of what extensions did to it during eval.
  const contentHash = createHash("sha256").update(source).digest("hex");

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

  // Mark collector — real if opted in, no-op otherwise. Always exposed
  // as host.mark so math files are portable between sim and server.
  const marks: MarkCollector = opts?.marks ? createMarkCollector() : noopMarkCollector();

  // Host imports exposed to the math. NB: no balance / bet / currency
  // helpers — by design. Math sees ONLY randomness, a logger, and
  // (optionally) annotation marks.
  lua.global.set("host", {
    rng_next: () => rng(),
    log_debug: (msg: string) => log.debug(`[lua:${path}] ${msg}`),
    mark: {
      count:      (name: string)               => marks.count(name),
      observe:    (name: string, value: number) => marks.observe(name, Number(value)),
      tag:        (name: string)               => marks.tag(name),
      contribute: (name: string, multiplier: number) => marks.contribute(name, Number(multiplier)),
    },
  });

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
        // Lua-table → JS object: wasmoon hands us a proxy-ish object we
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
  // chain to Lua's default package.loaders — math should depend only on
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

  // Apply transforms to the user's math source and evaluate.
  const transformedSource = applyTransforms(source, path);
  await lua.doString(`__open_rgs_math = (function() ${transformedSource} end)()`);
  const api = lua.global.get("__open_rgs_math") as LuaApi | undefined;
  if (!api || typeof api !== "object") {
    throw new Error(`Lua math at ${path} did not return a table`);
  }

  const kind = api.kind === "complex" ? "complex" : "simple";
  const name = api.name ?? path;
  const version = api.version ?? "0.0.0";
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
      play(prev: CarryState | undefined, ctx: SpinContext): RoundOutcome {
        const raw = api.play!(prev, ctx);
        return adaptRoundOutcome(raw);
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
    open(prev: CarryState | undefined, ctx: SpinContext): OpenOutcome {
      return adaptOpenOutcome(api.open!(prev, ctx));
    },
    step(state: RoundState, action: PlayerAction): StepOutcome {
      return adaptStepOutcome(api.step!(state, action));
    },
    isTerminal(state: RoundState): boolean {
      return Boolean(api.is_terminal!(state));
    },
    close(state: RoundState): CloseOutcome {
      return adaptCloseOutcome(api.close!(state));
    },
    autoclose: typeof api.autoclose === "function"
      ? (state: RoundState) => adaptCloseOutcome(api.autoclose!(state))
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

// ─── Lua → TS adapters ──────────────────────────────────────────────────────
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
