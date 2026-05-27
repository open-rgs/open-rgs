// HTML report via Handlebars. Self-contained single-file output: inline
// CSS, inline JS, no external assets. Styled to match the open-rgs.dev
// site (warm-paper light, warm-charcoal dark, Charter serif).
//
// Use:
//   import { htmlReportSet } from "@open-rgs/simulator";
//   await Bun.write("report.html", htmlReportSet(reports));
//
// Custom template? Pass `template: string` (raw .hbs source) in options.

import Handlebars from "handlebars";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SimulationReport } from "./report.js";
import type { TargetDeviation, DeviationStatus } from "./deviation.js";

const here = dirname(fileURLToPath(import.meta.url));
const defaultTemplateSrc = readFileSync(join(here, "templates", "default.hbs"), "utf-8");

let helpersRegistered = false;
function ensureHelpers(): void {
  if (helpersRegistered) return;
  helpersRegistered = true;

  Handlebars.registerHelper("pct", (n: unknown) => formatPct(toNum(n)));
  Handlebars.registerHelper("pctSigned", (n: unknown) => {
    const v = toNum(n);
    return (v >= 0 ? "+" : "") + (v * 100).toFixed(2) + "%";
  });
  Handlebars.registerHelper("fixed", (n: unknown, digits: unknown) => {
    const d = typeof digits === "number" ? digits : 2;
    return toNum(n).toFixed(d);
  });
  Handlebars.registerHelper("fixedSigned", (n: unknown, digits: unknown) => {
    const d = typeof digits === "number" ? digits : 2;
    const v = toNum(n);
    return (v >= 0 ? "+" : "") + v.toFixed(d);
  });
  Handlebars.registerHelper("numLocale", (n: unknown) => toNum(n).toLocaleString());
  Handlebars.registerHelper("eq", (a: unknown, b: unknown) => a === b);
  Handlebars.registerHelper("gt", (a: unknown, b: unknown) => toNum(a) > toNum(b));
  Handlebars.registerHelper("div", (a: unknown, b: unknown) => {
    const d = toNum(b);
    return d === 0 ? 0 : toNum(a) / d;
  });

  // {{#each (entries obj)}} → iterate { key, value } pairs.
  Handlebars.registerHelper("entries", (obj: unknown) => {
    if (!obj || typeof obj !== "object") return [];
    return Object.entries(obj as Record<string, unknown>).map(([key, value]) => ({ key, value }));
  });

  Handlebars.registerHelper("anyEntries", (obj: unknown) => {
    if (!obj || typeof obj !== "object") return false;
    return Object.keys(obj as Record<string, unknown>).length > 0;
  });

  // Sorted entries for outcomeTypes / nextModeRoutes (record<string, number>): desc by value.
  Handlebars.registerHelper("sortEntries", (obj: unknown) => {
    if (!obj || typeof obj !== "object") return [];
    return Object.entries(obj as Record<string, number>)
      .map(([key, value]) => ({ key, value }))
      .sort((a, b) => b.value - a.value);
  });

  // Counters: desc by .total
  Handlebars.registerHelper("sortCounters", (obj: unknown) => {
    if (!obj || typeof obj !== "object") return [];
    return Object.entries(obj as Record<string, { total: number; perSpin: number }>)
      .map(([key, value]) => ({ key, value }))
      .sort((a, b) => b.value.total - a.value.total);
  });

  // Tag shares: desc by .spins
  Handlebars.registerHelper("sortTags", (obj: unknown) => {
    if (!obj || typeof obj !== "object") return [];
    return Object.entries(obj as Record<string, { spins: number; share: number }>)
      .map(([key, value]) => ({ key, value }))
      .sort((a, b) => b.value.spins - a.value.spins);
  });

  // Contributions: desc by .rtpShare
  Handlebars.registerHelper("sortContributions", (obj: unknown) => {
    if (!obj || typeof obj !== "object") return [];
    return Object.entries(obj as Record<string, { sumMultiplier: number; rtpShare: number }>)
      .map(([key, value]) => ({ key, value }))
      .sort((a, b) => b.value.rtpShare - a.value.rtpShare);
  });

  // Status badge: count by status (ok/warn/fail), sorted fail-first.
  Handlebars.registerHelper("statusCounts", (deviations: unknown) => {
    if (!Array.isArray(deviations)) return [];
    const counts: Record<DeviationStatus, number> = { fail: 0, warn: 0, ok: 0 };
    for (const d of deviations as TargetDeviation[]) {
      counts[d.status] = (counts[d.status] ?? 0) + 1;
    }
    return (["fail", "warn", "ok"] as DeviationStatus[])
      .filter(k => counts[k] > 0)
      .map(k => ({ key: k, value: counts[k] }));
  });
}

export interface HtmlReportOptions {
  /** Override the default template. Pass raw .hbs source. */
  template?: string;
  /** Override the "generated at" timestamp. Default = new Date().toISOString(). */
  generatedAt?: string;
  /** Override the generator string. Default = "@open-rgs/simulator". */
  generator?: string;
}

/** Render all reports as a single self-contained HTML document. */
export function htmlReportSet(
  reports: readonly SimulationReport[],
  opts: HtmlReportOptions = {},
): string {
  ensureHelpers();
  const template = Handlebars.compile(opts.template ?? defaultTemplateSrc, { noEscape: false });
  return template({
    reports,
    game: reports[0]?.game ?? { id: "(empty)", declaredRtp: 0, defaultMode: "(none)" },
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    generator: opts.generator ?? "@open-rgs/simulator",
  });
}

function toNum(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number(v);
  return 0;
}

function formatPct(n: number): string {
  return (n * 100).toFixed(2) + "%";
}
