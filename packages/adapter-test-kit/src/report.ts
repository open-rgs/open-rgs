// Markdown rendering for ConformanceReport. Fits in a PR comment;
// designed to be diffable across adapter revisions.

import type { ConformanceReport, CheckStatus } from "./types.js";

const STATUS_GLYPH: Record<CheckStatus, string> = {
  ok:   "✓",
  warn: "!",
  fail: "✗",
  skip: "—",
};

export function mdConformanceReport(report: ConformanceReport): string {
  const lines: string[] = [];
  lines.push(`# Conformance — ${report.adapter.name} @ ${report.adapter.version}`);
  lines.push("");
  lines.push(`${report.summary.ok} ok · ${report.summary.warn} warn · ${report.summary.fail} fail · ${report.summary.skip} skip (${report.summary.total} total, ${report.elapsedMs}ms)`);
  lines.push("");
  lines.push(`Started: ${report.startedAt}`);
  lines.push(`Finished: ${report.finishedAt}`);
  lines.push("");

  // Group by group, sort fails/warns first inside each group.
  const groups = new Map<string, ConformanceReport["checks"]>();
  for (const c of report.checks) {
    if (!groups.has(c.group)) groups.set(c.group, []);
    groups.get(c.group)!.push(c);
  }
  const groupOrder: Record<CheckStatus, number> = { fail: 0, warn: 1, ok: 2, skip: 3 };
  for (const [g, items] of groups) {
    items.sort((a, b) => groupOrder[a.status] - groupOrder[b.status]);
    lines.push(`## ${g}`);
    lines.push("");
    lines.push("| status | id | description | ms | message |");
    lines.push("|--------|----|-------------|----|---------|");
    for (const c of items) {
      const glyph = STATUS_GLYPH[c.status];
      const msg = c.message ? c.message.replace(/\|/g, "\\|").slice(0, 120) : "";
      lines.push(`| **${glyph} ${c.status}** | \`${c.id}\` | ${c.description} | ${c.durationMs} | ${msg} |`);
    }
    lines.push("");
    void g; // (group used above)
  }

  if (report.summary.fail === 0 && report.summary.warn === 0) {
    lines.push("> All conformance checks within tolerance.");
  } else {
    lines.push("> " + (report.summary.fail > 0
      ? `${report.summary.fail} check${report.summary.fail === 1 ? "" : "s"} FAILED — adapter does not meet the @open-rgs/contract requirements.`
      : `${report.summary.warn} warning${report.summary.warn === 1 ? "" : "s"} — adapter works but has rough edges.`));
  }
  lines.push("");

  return lines.join("\n");
}
