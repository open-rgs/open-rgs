// Target-vs-measured deviation. Each entry in the author's
// MathExpectations produces one TargetDeviation; the simulator embeds
// them in the report so consumers (and LLMs) can scan for what's off.

import type { MathExpectations, MathTarget } from "@open-rgs/contract";

export type DeviationStatus = "ok" | "warn" | "fail";

export interface TargetDeviation {
  /** Dotted key, e.g. "hit_rate", "rate.scatter_trigger",
   *  "rtp_contribution.scatter", "tag_share.feature". */
  key: string;
  target: number;
  measured: number;
  /** measured - target. */
  delta: number;
  /** Absolute tolerance band (derived if not declared: 5% of |target|). */
  tolerance: number;
  status: DeviationStatus;
}

interface MeasuredSeries {
  hitRate: number;
  rates: Record<string, number>;          // per-spin rate of named counter
  rtpContributions: Record<string, number>; // RTP fraction of named bucket
  tagShares: Record<string, number>;      // per-spin share of tagged spins
}

/** Compute one TargetDeviation per declared target in `expected`. Quiet
 *  when `expected` is undefined  - no opinions, no entries. */
export function computeDeviations(
  expected: MathExpectations | undefined,
  measured: MeasuredSeries,
): TargetDeviation[] {
  if (!expected) return [];
  const out: TargetDeviation[] = [];

  if (expected.hitRate) {
    out.push(make("hit_rate", expected.hitRate, measured.hitRate));
  }
  for (const [name, t] of Object.entries(expected.rate ?? {})) {
    out.push(make(`rate.${name}`, t, measured.rates[name] ?? 0));
  }
  for (const [name, t] of Object.entries(expected.rtpContribution ?? {})) {
    out.push(make(`rtp_contribution.${name}`, t, measured.rtpContributions[name] ?? 0));
  }
  for (const [name, t] of Object.entries(expected.tagShare ?? {})) {
    out.push(make(`tag_share.${name}`, t, measured.tagShares[name] ?? 0));
  }

  // Stable sort: status (fail -> warn -> ok), then key.
  const order: Record<DeviationStatus, number> = { fail: 0, warn: 1, ok: 2 };
  out.sort((a, b) => order[a.status] - order[b.status] || a.key.localeCompare(b.key));
  return out;
}

function make(key: string, t: MathTarget, measured: number): TargetDeviation {
  const tolerance = t.tolerance ?? Math.max(Math.abs(t.target) * 0.05, 1e-9);
  const delta = measured - t.target;
  const adelta = Math.abs(delta);
  const status: DeviationStatus =
    adelta <= tolerance      ? "ok" :
    adelta <= 2 * tolerance  ? "warn" :
                               "fail";
  return { key, target: t.target, measured, delta, tolerance, status };
}

/** Generate a short, machine-readable narrative summarising the report
 *  for AI consumption. Designed to be quotable and grep-able. */
export function narrate(
  game: string,
  mode: string,
  rtp: { measured: number; declared: number; delta: number },
  hitRate: number,
  deviations: readonly TargetDeviation[],
  topContributions: ReadonlyArray<{ name: string; rtpShare: number }>,
): string {
  const fails = deviations.filter(d => d.status === "fail");
  const warns = deviations.filter(d => d.status === "warn");
  const oks   = deviations.filter(d => d.status === "ok");
  const pct = (n: number) => (n * 100).toFixed(2) + "%";
  const sgn = (n: number) => (n >= 0 ? "+" : "") + (n * 100).toFixed(2) + "%";

  const parts: string[] = [];
  parts.push(
    `${game}/${mode}: RTP ${pct(rtp.measured)} (declared ${pct(rtp.declared)}, delta ${sgn(rtp.delta)}); hit rate ${pct(hitRate)}.`,
  );

  if (deviations.length === 0) {
    parts.push("No author-declared targets to compare.");
  } else if (fails.length === 0 && warns.length === 0) {
    parts.push(`All ${oks.length} declared targets within tolerance.`);
  } else {
    if (fails.length > 0) {
      parts.push(
        `${fails.length} target${fails.length === 1 ? "" : "s"} FAIL: ` +
        fails.slice(0, 3).map(d => `${d.key}=${num(d.measured)} (target ${num(d.target)}, delta ${signedNum(d.delta)})`).join("; ") +
        (fails.length > 3 ? `; +${fails.length - 3} more` : "") + ".",
      );
    }
    if (warns.length > 0) {
      parts.push(
        `${warns.length} target${warns.length === 1 ? "" : "s"} WARN: ` +
        warns.slice(0, 3).map(d => `${d.key}=${num(d.measured)} (target ${num(d.target)})`).join("; ") +
        (warns.length > 3 ? `; +${warns.length - 3} more` : "") + ".",
      );
    }
    if (oks.length > 0) parts.push(`${oks.length} target${oks.length === 1 ? "" : "s"} ok.`);
  }

  if (topContributions.length > 0) {
    parts.push(
      `Top RTP contributors: ` +
      topContributions.slice(0, 3).map(c => `${c.name} (${pct(c.rtpShare)})`).join(", ") + ".",
    );
  }

  return parts.join(" ");
}

function num(n: number): string {
  if (Math.abs(n) < 1e-6) return "0";
  if (Math.abs(n) < 0.01) return n.toExponential(2);
  return n.toFixed(4);
}
function signedNum(n: number): string {
  const s = num(Math.abs(n));
  return (n >= 0 ? "+" : "-") + s;
}
