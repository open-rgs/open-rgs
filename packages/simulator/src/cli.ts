#!/usr/bin/env bun
// open-rgs-sim — CLI front-end for @open-rgs/simulator.
//
// Usage:
//   bunx open-rgs-sim <manifest-module> [--spins N] [--seed N] [--out DIR]
//                                       [--format md|html|json|all]
//
// <manifest-module> is a TS / JS file that default-exports either:
//   • a GameManifest, OR
//   • an async function returning a GameManifest
//
// Examples:
//   bunx open-rgs-sim ./src/manifest.ts
//   bunx open-rgs-sim ./src/manifest.ts --spins 250000 --seed 7
//   bunx open-rgs-sim ./src/manifest.ts --out reports --format html

import { resolve, dirname, join, basename } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { simulate } from "./simulate.js";
import { mdReportSet } from "./report.js";
import { htmlReportSet } from "./html.js";
import type { GameManifest } from "@open-rgs/contract";

interface CliOpts {
  manifestPath: string;
  spins: number;
  seed: number;
  outDir: string;
  format: "md" | "html" | "json" | "all";
  betUnits: number;
  includeInternal: boolean;
  quiet: boolean;
}

function parseArgs(argv: readonly string[]): CliOpts {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else { flags[a.slice(2)] = argv[++i] ?? "true"; }
    } else {
      positional.push(a);
    }
  }
  if (positional.length === 0) usageAndExit("missing <manifest-module> argument");
  return {
    manifestPath: positional[0]!,
    spins: Number(flags["spins"] ?? "100000"),
    seed: Number(flags["seed"] ?? "0"),
    outDir: flags["out"] ?? "./reports",
    format: ((flags["format"] ?? "all") as CliOpts["format"]),
    betUnits: Number(flags["bet"] ?? "1"),
    includeInternal: flags["skip-internal"] === "true" ? false : true,
    quiet: flags["quiet"] === "true",
  };
}

function usageAndExit(msg: string): never {
  process.stderr.write(`open-rgs-sim: ${msg}\n\n`);
  process.stderr.write(`Usage: bunx open-rgs-sim <manifest-module> [opts]\n`);
  process.stderr.write(`Opts:\n`);
  process.stderr.write(`  --spins N            spins per mode (default 100000)\n`);
  process.stderr.write(`  --seed N             simulator PRNG seed (default 0)\n`);
  process.stderr.write(`  --bet N              units per spin pre-stakeMultiplier (default 1)\n`);
  process.stderr.write(`  --out DIR            output directory (default ./reports)\n`);
  process.stderr.write(`  --format md|html|json|all   (default all)\n`);
  process.stderr.write(`  --skip-internal      skip modes flagged { internal: true }\n`);
  process.stderr.write(`  --quiet              suppress stdout progress lines\n`);
  process.exit(2);
}

async function loadManifest(modulePath: string, seed: number): Promise<GameManifest> {
  const abs = resolve(process.cwd(), modulePath);
  const mod = await import(abs);
  // Accept default export, named `manifest`, or named `buildManifest`.
  // Functions are called with `{ seed }` so they can seed the math's RNG.
  const candidate = mod.default ?? mod.manifest ?? mod.buildManifest;
  if (candidate == null) {
    usageAndExit(`module ${modulePath} does not export default / manifest / buildManifest`);
  }
  const resolved = typeof candidate === "function" ? await candidate({ seed }) : candidate;
  if (!resolved || typeof resolved !== "object" || typeof resolved.id !== "string") {
    usageAndExit(`module ${modulePath} did not produce a GameManifest`);
  }
  return resolved as GameManifest;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const manifest = await loadManifest(opts.manifestPath, opts.seed);

  if (!opts.quiet) {
    process.stderr.write(`open-rgs-sim · ${manifest.id} · ${opts.spins.toLocaleString()} spins/mode · seed ${opts.seed}\n`);
  }

  const reports = await simulate(manifest, {
    spinsPerMode: opts.spins,
    seed: opts.seed,
    betUnits: opts.betUnits,
    includeInternal: opts.includeInternal,
  });

  await mkdir(opts.outDir, { recursive: true });
  const stem = `${manifest.id}-seed${opts.seed}-spins${opts.spins}`;
  const wrote: string[] = [];

  if (opts.format === "all" || opts.format === "md") {
    const p = join(opts.outDir, `${stem}.md`);
    await writeFile(p, mdReportSet(reports), "utf-8");
    wrote.push(p);
  }
  if (opts.format === "all" || opts.format === "html") {
    const p = join(opts.outDir, `${stem}.html`);
    await writeFile(p, htmlReportSet(reports), "utf-8");
    wrote.push(p);
  }
  if (opts.format === "all" || opts.format === "json") {
    const p = join(opts.outDir, `${stem}.json`);
    await writeFile(p, JSON.stringify({
      schema:  "open-rgs/simulator/report@1",
      game:    reports[0]?.game ?? null,
      reports,
    }, null, 2), "utf-8");
    wrote.push(p);
  }

  if (!opts.quiet) {
    for (const p of wrote) process.stderr.write(`→ ${p}\n`);
    // Always print the one-line narrative(s) to stdout for grep/jq.
    for (const r of reports) process.stdout.write(`${r.narrative}\n`);
  }
}

main().catch(e => {
  process.stderr.write(`open-rgs-sim: ${e instanceof Error ? e.message : String(e)}\n`);
  if (e instanceof Error && e.stack) process.stderr.write(e.stack + "\n");
  process.exit(1);
});

// Silence "unused" warnings for path helpers — they're imported for runtime use only.
void dirname; void basename;
