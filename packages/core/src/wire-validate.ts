// Shape checks for decoded wire payloads.
//
// A transport decodes MessagePack or JSON and hands the result to the
// orchestrator. A cast (`payload as ClientRequestSpin`) checks nothing at
// runtime: TypeScript erases, and these values are not inert. `sid` becomes a
// session-store key and an argument to the wallet adapter, `params` is handed
// to the math untouched, and `action` is compared against the awaiting hint
// and passed to `step`.
//
// Without a check, a client can open a session keyed by a number, or by an
// object. Nothing downstream expects that, and the failure surfaces far from
// its cause.
//
// These checks are deliberately shallow: types and bounds for the fields the
// engine itself reads, and nothing about `params`, whose contents belong to the
// math. They reject with INVALID_FORMAT, which is a 400 - the client's mistake,
// stated plainly, before any of it reaches a session or a round.

import { RGSError } from "@open-rgs/contract";
import type {
  ClientRequestInit, ClientRequestSpin, ClientRequestOpenRound,
  ClientRequestStepRound, ClientRequestCloseRound, ClientRequestPromoAccept,
} from "@open-rgs/contract";

export type WireCall = "init" | "spin" | "open" | "step" | "close" | "promo";

interface WireShapes {
  init: ClientRequestInit;
  spin: ClientRequestSpin;
  open: ClientRequestOpenRound;
  step: ClientRequestStepRound;
  close: ClientRequestCloseRound;
  promo: ClientRequestPromoAccept;
}

/** Longest accepted session id / mode id / idempotency token. Long enough for
 *  any real identifier, short enough that a crafted one cannot be used to grow
 *  server-side maps. */
const MAX_ID_LEN = 256;

function bad(what: string): never {
  throw new RGSError("INVALID_FORMAT", what);
}

function obj(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    bad("request payload must be an object");
  }
  return payload as Record<string, unknown>;
}

function optionalId(v: unknown, field: string): void {
  if (v === undefined || v === null) return;
  if (typeof v !== "string") bad(`${field} must be a string`);
  if (v.length === 0) bad(`${field} must not be empty`);
  if (v.length > MAX_ID_LEN) bad(`${field} must be at most ${MAX_ID_LEN} characters`);
}

function optionalIndex(v: unknown, field: string): void {
  if (v === undefined || v === null) return;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    bad(`${field} must be a non-negative integer`);
  }
}

function optionalParams(v: unknown): void {
  if (v === undefined || v === null) return;
  if (typeof v !== "object" || Array.isArray(v)) bad("params must be an object");
}

/** Validate a decoded payload for `call` and return it typed. Throws
 *  RGSError("INVALID_FORMAT") on anything the engine cannot read. */
export function validateRequest<C extends WireCall>(call: C, payload: unknown): WireShapes[C] {
  const p = obj(payload);

  optionalId(p["sid"], "sid");
  optionalId(p["idempotencyKey"], "idempotencyKey");

  switch (call) {
    case "init":
      // sid is required for INIT specifically; the orchestrator says so too,
      // but saying it here gives the client a 400 instead of a 401.
      if (typeof p["sid"] !== "string") bad("sid is required");
      break;

    case "spin":
    case "open":
      optionalId(p["mode"], "mode");
      optionalIndex(p["betIndex"], "betIndex");
      optionalIndex(p["priceMultiplier"], "priceMultiplier");
      optionalParams(p["params"]);
      break;

    case "step": {
      const action = p["action"];
      if (!action || typeof action !== "object" || Array.isArray(action)) {
        bad("action must be an object");
      }
      const type = (action as Record<string, unknown>)["type"];
      if (typeof type !== "string" || type.length === 0) bad("action.type must be a non-empty string");
      if (type.length > MAX_ID_LEN) bad(`action.type must be at most ${MAX_ID_LEN} characters`);
      break;
    }

    case "close":
      break;

    case "promo":
      if (typeof p["accept"] !== "boolean") bad("accept must be a boolean");
      break;
  }

  return payload as WireShapes[C];
}
