// Currency conversion helpers for PlatformAdapter authors.
//
// open-rgs internally uses INTEGER MINOR UNITS for every amount
// (balance, bet, win, multiplier x bet, etc.). The currency's number of
// fractional digits is carried on SessionInfo.currencyDecimals  - sourced
// by the adapter from its upstream platform.
//
// Adapters whose upstream platform speaks integer minor units don't need
// these helpers  - pass amounts through. Adapters facing platforms that
// expect decimal strings ("150.50") or floats (150.5) use toWireAmount on
// outbound and fromWireAmount on inbound, with an explicit rounding
// policy.
//
// Why a helper instead of raw arithmetic: float conversions lose
// precision (0.1 + 0.2 -> 0.30000000000000004). A typo in the decimal
// shift is silent and loses money over time. Centralising it lets us
// test edge cases once and reuse correctly.

/** How to break ties when converting fractional-precision wire values
 *  (decimal strings with more digits than the currency permits, or
 *  floats) into integer minor units.
 *
 *  - `half_even` (default): banker's rounding. Rounds to nearest; ties
 *    go to the even neighbor. Statistically unbiased over many
 *    conversions  - the regulator-friendly choice.
 *  - `half_up`: rounds to nearest; ties go away from zero (1.5 -> 2,
 *    -1.5 -> -2). Familiar but slightly biased upward.
 *  - `half_down`: rounds to nearest; ties go toward zero.
 *  - `floor`: always rounds toward negative infinity.
 *  - `ceiling`: always rounds toward positive infinity.
 */
export type RoundingMode = "half_even" | "half_up" | "half_down" | "floor" | "ceiling";

/** What shape the upstream platform expects amounts in.
 *
 *  - `integer`: minor units as integers. e.g. `15050` for $150.50.
 *    (Conversion is identity  - pass through.)
 *  - `decimal_string`: decimal-formatted strings. e.g. `"150.50"`.
 *    Stable, lossless, regulator-preferred.
 *  - `float`: IEEE-754 doubles. e.g. `150.5`. Lossy at scale, avoid
 *    when possible.
 */
export type WireFormat = "integer" | "decimal_string" | "float";

/** Convert an integer-minor-units amount (RGS internal) into the wire
 *  format the upstream platform expects.
 *
 *  @param minorUnits  amount as an integer in minor units (e.g. 15050)
 *  @param decimals    fractional digits of the currency (e.g. 2 for EUR)
 *  @param format      shape the platform expects on the wire
 *  @param _rounding   only relevant when going INTO minor units;
 *                     ignored here (the integer input is already exact)
 *  @returns           the wire-shaped value: number for integer/float,
 *                     string for decimal_string
 *
 *  @example
 *    toWireAmount(15050, 2, "decimal_string")  // "150.50"
 *    toWireAmount(15050, 2, "float")            // 150.5
 *    toWireAmount(15050, 2, "integer")          // 15050
 *    toWireAmount(0,     2, "decimal_string")  // "0.00"
 *    toWireAmount(-150,  2, "decimal_string")  // "-1.50"
 *    toWireAmount(15050, 0, "decimal_string")  // "15050"  (no decimal point)
 */
export function toWireAmount(
  minorUnits: number,
  decimals: number,
  format: WireFormat,
  _rounding: RoundingMode = "half_even",
): string | number {
  if (!Number.isInteger(minorUnits)) {
    throw new TypeError(
      `toWireAmount: minorUnits must be an integer (got ${minorUnits}). ` +
      `RGS internal amounts are always integer minor units; convert at the adapter boundary, never before.`,
    );
  }
  if (decimals < 0 || !Number.isInteger(decimals)) {
    throw new TypeError(`toWireAmount: decimals must be a non-negative integer (got ${decimals})`);
  }

  if (format === "integer") return minorUnits;

  // Lossy at scale, but sometimes required by the upstream contract.
  if (format === "float") {
    return minorUnits / Math.pow(10, decimals);
  }

  // decimal_string  - lossless, the safe default
  if (decimals === 0) return String(minorUnits);
  const sign = minorUnits < 0 ? "-" : "";
  const abs = Math.abs(minorUnits);
  const factor = Math.pow(10, decimals);
  const whole = Math.trunc(abs / factor);
  const frac = abs % factor;
  return `${sign}${whole}.${String(frac).padStart(decimals, "0")}`;
}

/** Convert an inbound wire value (whatever shape the platform sent)
 *  into an integer-minor-units amount for RGS internal use.
 *
 *  When the wire value has more fractional precision than the currency
 *  permits (decimal "1.005" with decimals=2, or a float that doesn't
 *  fit cleanly), `rounding` decides how the tie is broken. Default
 *  is `half_even`  - the statistically unbiased choice.
 *
 *  @returns  integer in minor units
 *
 *  @example
 *    fromWireAmount("150.50", 2, "decimal_string")              // 15050
 *    fromWireAmount(150.50,    2, "float")                       // 15050
 *    fromWireAmount(15050,     2, "integer")                     // 15050
 *    fromWireAmount("1.005",   2, "decimal_string")              // 100 (half_even)
 *    fromWireAmount("1.005",   2, "decimal_string", "half_up")   // 101
 *    fromWireAmount("-1.50",   2, "decimal_string")              // -150
 */
export function fromWireAmount(
  value: string | number,
  decimals: number,
  format: WireFormat,
  rounding: RoundingMode = "half_even",
): number {
  if (decimals < 0 || !Number.isInteger(decimals)) {
    throw new TypeError(`fromWireAmount: decimals must be a non-negative integer (got ${decimals})`);
  }

  if (format === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      throw new TypeError(`fromWireAmount(integer): expected integer, got ${typeof value} ${value}`);
    }
    return safeMinor(value);
  }

  if (format === "float") {
    if (typeof value !== "number") {
      throw new TypeError(`fromWireAmount(float): expected number, got ${typeof value} ${value}`);
    }
    return safeMinor(applyRounding(value * Math.pow(10, decimals), rounding));
  }

  // decimal_string
  if (typeof value !== "string") {
    throw new TypeError(`fromWireAmount(decimal_string): expected string, got ${typeof value} ${value}`);
  }
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new TypeError(`fromWireAmount(decimal_string): malformed value "${value}"`);
  }
  const negative = trimmed.startsWith("-");
  const body = negative ? trimmed.slice(1) : trimmed;
  const [whole, fracRaw = ""] = body.split(".");
  // Pad or trim the fractional part to the currency's precision.
  if (fracRaw.length <= decimals) {
    // No precision loss  - the wire value fits within the currency's grid.
    const padded = fracRaw.padEnd(decimals, "0");
    const exact = Number(whole + padded);
    return safeMinor(negative ? -exact : exact);
  }
  // Wire value has more precision than the currency  - round from the dropped
  // tail. Decide the tie by STRING comparison, never by reparsing the tail as
  // a float: `Number("0." + "4999999999999999999") === 0.5`, which would make
  // half-even/half-up break at exactly the boundary they exist to handle.
  const base = Number(whole + fracRaw.slice(0, decimals));
  return safeMinor(roundFromTail(base, fracRaw.slice(decimals), negative, rounding));
}

/** Guard a converted minor-unit amount: `number` silently loses integer
 *  precision past 2^53, so a value beyond the safe range is a corruption, not
 *  an amount. Reject it loudly  - high-decimal currencies (BTC sats) or huge
 *  balances need bigint money (audit H1 / ADR-002). */
function safeMinor(n: number): number {
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(
      `fromWireAmount: ${n} exceeds the safe integer range (+/-${Number.MAX_SAFE_INTEGER}); ` +
      `amounts this large need bigint money`,
    );
  }
  return n;
}

/** Round a magnitude `base` up or down based on the dropped decimal `tail`
 *  (a non-empty digit string) and sign, deciding ties from the string  - no
 *  float. Returns the signed integer. */
function roundFromTail(base: number, tail: string, negative: boolean, mode: RoundingMode): number {
  const tailHasNonZero = /[1-9]/.test(tail);
  // Compare the dropped fraction to exactly one half.
  const firstDigit = tail.charCodeAt(0) - 48;
  const restNonZero = /[1-9]/.test(tail.slice(1));
  const cmpHalf = firstDigit < 5 ? -1 : firstDigit > 5 ? 1 : (restNonZero ? 1 : 0);

  let up: boolean;
  switch (mode) {
    case "floor":     up = negative && tailHasNonZero; break;   // toward -inf
    case "ceiling":   up = !negative && tailHasNonZero; break;  // toward +inf
    case "half_up":   up = cmpHalf >= 0; break;                 // ties away from zero
    case "half_down": up = cmpHalf > 0; break;                  // ties toward zero
    case "half_even": up = cmpHalf > 0 || (cmpHalf === 0 && base % 2 === 1); break;
    default:          up = cmpHalf >= 0;
  }
  const mag = up ? base + 1 : base;
  return negative ? -mag : mag;
}

/** Apply a rounding mode to a numeric value, returning an integer. */
function applyRounding(x: number, mode: RoundingMode): number {
  switch (mode) {
    case "floor":     return Math.floor(x);
    case "ceiling":   return Math.ceil(x);
    case "half_up": {
      // Standard "round half away from zero"
      return x >= 0 ? Math.floor(x + 0.5) : -Math.floor(-x + 0.5);
    }
    case "half_down": {
      // "Round half toward zero"
      return x >= 0 ? Math.ceil(x - 0.5) : -Math.ceil(-x - 0.5);
    }
    case "half_even":
    default: {
      // Banker's rounding: ties go to the even neighbor.
      const floor = Math.floor(x);
      const diff = x - floor;
      if (diff < 0.5) return floor;
      if (diff > 0.5) return floor + 1;
      // Tie exactly  - pick the even side
      return floor % 2 === 0 ? floor : floor + 1;
    }
  }
}
