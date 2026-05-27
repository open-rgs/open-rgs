import { describe, expect, test } from "bun:test";
import { ErrorMap } from "../src/index.js";
import { RGSError } from "@open-rgs/contract";

describe("ErrorMap", () => {
  test("regex match -> declared RGSErrorCode", () => {
    const m = new ErrorMap()
      .when(/balance.*low/i, "INSUFFICIENT_BALANCE")
      .when(/session/i, "SESSION_INVALID");
    const e = m.translate(new Error("Balance is too LOW"));
    expect(e).toBeInstanceOf(RGSError);
    expect(e.code).toBe("INSUFFICIENT_BALANCE");
  });

  test("first match wins", () => {
    const m = new ErrorMap()
      .when(/session/i, "SESSION_INVALID")
      .when(/session expired/i, "MISSING_SESSION");
    const e = m.translate(new Error("session expired"));
    expect(e.code).toBe("SESSION_INVALID");
  });

  test("predicate match supported", () => {
    const m = new ErrorMap()
      .when((s) => s.includes("dedup-key"), "INTERNAL_ERROR");
    const e = m.translate(new Error("dedup-key collision"));
    expect(e.code).toBe("INTERNAL_ERROR");
  });

  test("fallback when no rule matches", () => {
    const m = new ErrorMap().otherwise("INTERNAL_ERROR");
    const e = m.translate(new Error("unknown thing"));
    expect(e.code).toBe("INTERNAL_ERROR");
  });

  test("idempotent on existing RGSError", () => {
    const original = new RGSError("INVALID_BET", "out of range");
    const m = new ErrorMap();
    expect(m.translate(original)).toBe(original);
  });

  test("non-Error throwables coerced to string", () => {
    const m = new ErrorMap()
      .when(/oops/, "INTERNAL_ERROR")
      .otherwise("INTERNAL_ERROR");
    expect(m.translate("oops").message).toBe("oops");
    expect(m.translate({ toString: () => "oops" }).code).toBe("INTERNAL_ERROR");
  });
});
