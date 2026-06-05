// Shared math-outcome adapters: normalise a raw outcome object (from a Lua
// table via wasmoon, or msgpack-decoded from a WASM kernel) into the canonical
// @open-rgs/contract shapes. No runtime dependency  - used by both loadLuaMath
// and loadWasmMath so they normalise identically (e.g. snake_case `next_mode`
// -> `nextMode`, 1-indexed arrays -> JS arrays, defaults).

import type {
  RoundOutcome, OpenOutcome, StepOutcome, CloseOutcome, Op,
  MathExpectations, MathTarget,
} from "@open-rgs/contract";

export function adaptExpectations(raw: unknown): MathExpectations | undefined {
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

// Outcomes come back as plain objects. Arrays may be 1-indexed objects (Lua)
// or proper arrays (msgpack/WASM); we normalise both.
function asArray<T = unknown>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (v && typeof v === "object") {
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

export function adaptRoundOutcome(raw: unknown): RoundOutcome {
  const o = raw as Record<string, unknown>;
  return {
    multiplier: Number(o["multiplier"] ?? 0),
    ops: asArray<Op>(o["ops"]),
    type: String(o["type"] ?? "spin"),
    carry: o["carry"] === undefined ? undefined : String(o["carry"]),
    nextMode: o["next_mode"] === undefined ? undefined : String(o["next_mode"]),
  };
}

export function adaptOpenOutcome(raw: unknown): OpenOutcome {
  const o = raw as Record<string, unknown>;
  return {
    state: String(o["state"] ?? ""),
    ops: asArray<Op>(o["ops"]),
    awaiting: adaptAwaiting(o["awaiting"]),
  };
}

export function adaptStepOutcome(raw: unknown): StepOutcome {
  const o = raw as Record<string, unknown>;
  return {
    state: String(o["state"] ?? ""),
    ops: asArray<Op>(o["ops"]),
    awaiting: adaptAwaiting(o["awaiting"]),
  };
}

export function adaptCloseOutcome(raw: unknown): CloseOutcome {
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
