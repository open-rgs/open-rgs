#!/usr/bin/env bun
// open-rgs-sim  - CLI front-end for @open-rgs/simulator.
//
// Usage:
//   bunx open-rgs-sim <manifest-module> [--spins N] [--seed N] [--out DIR]
//                                       [--format md|html|json|all] [--shards N]
//
// <manifest-module> is a TS / JS file that default-exports either:
//   - a GameManifest, OR
//   - an async function returning a GameManifest
//
// Examples:
//   bunx open-rgs-sim ./src/manifest.ts
//   bunx open-rgs-sim ./src/manifest.ts --spins 250000 --seed 7
//   bunx open-rgs-sim ./src/manifest.ts --spins 4000000 --shards 8
//
// --shards N (N>1) splits the spins across N independently-seeded worker
// processes (one per core) and merges the results - near-linear speedup for
// big runs. It REQUIRES the module to export a factory `({ seed }) => manifest`
// so each shard gets its own RNG substream; a static manifest is refused
// (all shards would draw the identical stream). See specs/06-performance.md.

import { resolve, join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { simulate } from "./simulate.js";
import { mergeReports } from "./merge.js";
import { mdReportSet, type SimulationReport } from "./report.js";
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
  shards: number;
  /** Internal: this process is one shard worker; run a slice, print JSON. */
  shardWorker: boolean;
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
    shards: Math.max(1, Math.floor(Number(flags["shards"] ?? "1")) || 1),
    shardWorker: flags["__shard-worker"] === "true",
  };
}

function usageAndExit(msg: string): never {
  process.stderr.write(`open-rgs-sim: ${msg}\n\n`);
  process.stderr.write(`Usage: bunx open-rgs-sim <manifest-module> [opts]\n`);
  process.stderr.write(`Opts:\n`);
  process.stderr.write(`  --spins N            spins per mode (default 100000)\n`);
  process.stderr.write(`  --seed N             simulator PRNG seed (default 0)\n`);
  process.stderr.write(`  --bet N              units per spin pre-stakeMultiplier (default 1)\n`);
  process.stderr.write(`  --shards N           split spins across N seeded worker processes (default 1)\n`);
  process.stderr.write(`  --out DIR            output directory (default ./reports)\n`);
  process.stderr.write(`  --format md|html|json|all   (default all)\n`);
  process.stderr.write(`  --skip-internal      skip modes flagged { internal: true }\n`);
  process.stderr.write(`  --quiet              suppress stdout progress lines\n`);
  process.exit(2);
}

/** Load the manifest module. Returns the manifest and whether its export is
 *  a seedable factory (required for sharding - each shard is called with a
 *  distinct seed so it draws an independent RNG substream). */
async function loadManifest(modulePath: string, seed: number): Promise<{ manifest: GameManifest; seedable: boolean }> {
  const abs = resolve(process.cwd(), modulePath);
  const mod = await import(abs);
  const candidate = mod.default ?? mod.manifest ?? mod.buildManifest;
  if (candidate == null) {
    usageAndExit(`module ${modulePath} does not export default / manifest / buildManifest`);
  }
  const seedable = typeof candidate === "function";
  const resolved = seedable ? await candidate({ seed }) : candidate;
  if (!resolved || typeof resolved !== "object" || typeof resolved.id !== "string") {
    usageAndExit(`module ${modulePath} did not produce a GameManifest`);
  }
  return { manifest: resolved as GameManifest, seedable };
}

/** Spread `total` spins across `shards` slices (remainder to the front). */
function shardSlices(total: number, shards: number): number[] {
  const per = Math.floor(total / shards);
  const rem = total - per * shards;
  return Array.from({ length: shards }, (_, i) => per + (i < rem ? 1 : 0)).filter(n => n > 0);
}

/** Derive a well-separated seed per shard so adjacent shards don't draw
 *  correlated mulberry32 streams. */
function shardSeed(base: number, i: number): number {
  let x = (base ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca77) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae3d) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

async function writeReports(reports: readonly SimulationReport[], opts: CliOpts, stem: string): Promise<string[]> {
  await mkdir(opts.outDir, { recursive: true });
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
  return wrote;
}

/** One shard worker: simulate this slice with this seed, print the reports as
 *  JSON to stdout (and nothing else), then exit. Invoked by runSharded. */
async function runShardWorker(opts: CliOpts): Promise<void> {
  const { manifest } = await loadManifest(opts.manifestPath, opts.seed);
  const reports = await simulate(manifest, {
    spinsPerMode: opts.spins,
    seed: opts.seed,
    betUnits: opts.betUnits,
    includeInternal: opts.includeInternal,
  });
  process.stdout.write(JSON.stringify(reports));
}

/** Parent: fan spins out to N seeded worker processes, merge per mode. */
async function runSharded(opts: CliOpts): Promise<void> {
  const manifestAbs = resolve(process.cwd(), opts.manifestPath);
  const { manifest, seedable } = await loadManifest(manifestAbs, opts.seed);

  // Fail closed: a static manifest can't be re-seeded per shard, so every
  // shard would draw the identical RNG stream - duplicated spins, a bogus
  // (over-confident, possibly biased) result. Refuse rather than mislead.
  if (!seedable) {
    process.stderr.write(
      `open-rgs-sim: cannot shard a static manifest - each shard needs an independent RNG ` +
      `substream. Export a factory \`({ seed }) => GameManifest\` (called with a distinct seed ` +
      `per shard), or run with --shards 1.\n`,
    );
    process.exit(2);
  }

  const slices = shardSlices(opts.spins, opts.shards);
  if (!opts.quiet) {
    process.stderr.write(`open-rgs-sim . ${manifest.id} . ${opts.spins.toLocaleString()} spins/mode across ${slices.length} shards . seed ${opts.seed}\n`);
  }

  const t0 = performance.now();
  const results = await Promise.all(slices.map(async (slice, i) => {
    const seed = shardSeed(opts.seed, i);
    const proc = Bun.spawn({
      cmd: [
        "bun", import.meta.path, manifestAbs,
        "--__shard-worker", "true",
        "--spins", String(slice),
        "--seed", String(seed),
        "--bet", String(opts.betUnits),
        "--skip-internal", opts.includeInternal ? "false" : "true",
      ],
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) throw new Error(`shard ${i} (seed ${seed}, ${slice} spins) failed [exit ${code}]: ${err.trim()}`);
    try {
      return JSON.parse(out) as SimulationReport[];
    } catch {
      throw new Error(`shard ${i} produced unparseable output: ${out.slice(0, 200)}`);
    }
  }));

  // Group each shard's reports by mode id, then merge per mode in the order
  // the first shard emitted them (manifest mode order).
  const order = results[0]?.map(r => r.mode.id) ?? [];
  const byMode = new Map<string, SimulationReport[]>();
  for (const shardReports of results) {
    for (const r of shardReports) {
      const list = byMode.get(r.mode.id) ?? [];
      list.push(r);
      byMode.set(r.mode.id, list);
    }
  }
  const merged = order.map(id =>
    mergeReports(byMode.get(id)!, manifest.modes[id]?.math.expected),
  );

  const stem = `${manifest.id}-seed${opts.seed}-spins${opts.spins}-shards${slices.length}`;
  const wrote = await writeReports(merged, opts, stem);

  if (!opts.quiet) {
    process.stderr.write(`done in ${Math.round(performance.now() - t0)}ms wall-clock (${slices.length} shards)\n`);
    for (const p of wrote) process.stderr.write(`-> ${p}\n`);
    for (const r of merged) process.stdout.write(`${r.narrative}\n`);
  }
}

/** Single-process run (the default, --shards 1). */
async function runSingle(opts: CliOpts): Promise<void> {
  const { manifest } = await loadManifest(opts.manifestPath, opts.seed);
  if (!opts.quiet) {
    process.stderr.write(`open-rgs-sim . ${manifest.id} . ${opts.spins.toLocaleString()} spins/mode . seed ${opts.seed}\n`);
  }
  const reports = await simulate(manifest, {
    spinsPerMode: opts.spins,
    seed: opts.seed,
    betUnits: opts.betUnits,
    includeInternal: opts.includeInternal,
  });
  const stem = `${manifest.id}-seed${opts.seed}-spins${opts.spins}`;
  const wrote = await writeReports(reports, opts, stem);
  if (!opts.quiet) {
    for (const p of wrote) process.stderr.write(`-> ${p}\n`);
    for (const r of reports) process.stdout.write(`${r.narrative}\n`);
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.shardWorker) return runShardWorker(opts);
  if (opts.shards > 1) return runSharded(opts);
  return runSingle(opts);
}

main().catch(e => {
  process.stderr.write(`open-rgs-sim: ${e instanceof Error ? e.message : String(e)}\n`);
  if (e instanceof Error && e.stack) process.stderr.write(e.stack + "\n");
  process.exit(1);
});
