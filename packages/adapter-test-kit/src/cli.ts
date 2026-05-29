#!/usr/bin/env bun
// open-rgs-adapter-conform — point this at a real or mock adapter
// implementation and get back a conformance report (md + json).
//
// Usage:
//   open-rgs-adapter-conform \
//     --adapter '@your-org/wallet-adapter' \
//     --export MyAdapter \
//     --opts '{"gameId":"example-game","wsUrl":"wss://platform.example.com/v1/ws?game=example-game","authToken":"…"}' \
//     --out-md ./conform.md
//
// Required flags:
//   --adapter <module>      npm package or absolute path to a JS/TS file
//                           exporting the adapter class
//   --export  <name>        named export of the adapter class
//                           (default: "default")
//
// Optional flags:
//   --opts    <json>        constructor options, JSON-encoded. May also
//                           be read from env ADAPTER_OPTS_JSON.
//   --skip-complex          skip complex-round checks
//   --skip-events           skip event checks
//   --timeout-ms <n>        per-check deadline, default 5000
//   --out-md  <path>        write markdown report here
//   --out-json <path>       write JSON report here
//
// Exit code: 0 if every non-skipped check is "ok", 1 otherwise.

import { runConformance, type RunOptions } from "./runner.js";
import { mdConformanceReport } from "./report.js";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { PlatformAdapter } from "@open-rgs/contract";

interface Args {
  adapter?: string;
  exportName?: string;
  opts?: string;
  skipComplex?: boolean;
  skipEvents?: boolean;
  timeoutMs?: number;
  outMd?: string;
  outJson?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${a}`);
      return v;
    };
    switch (a) {
      case "--adapter":     out.adapter    = next(); break;
      case "--export":      out.exportName = next(); break;
      case "--opts":        out.opts       = next(); break;
      case "--skip-complex": out.skipComplex = true; break;
      case "--skip-events":  out.skipEvents  = true; break;
      case "--timeout-ms":  out.timeoutMs  = Number(next()); break;
      case "--out-md":      out.outMd      = next(); break;
      case "--out-json":    out.outJson    = next(); break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
    }
  }
  return out;
}

function printHelp(): void {
  process.stdout.write(`open-rgs-adapter-conform — run conformance against a real or mock adapter

Required:
  --adapter <module>      module specifier (npm name or absolute path)
  --export  <name>        named export of the adapter class (default "default")

Optional:
  --opts    <json>        JSON constructor options. Or env ADAPTER_OPTS_JSON.
  --skip-complex          skip complex-round checks
  --skip-events           skip event checks
  --timeout-ms <n>        per-check deadline (default 5000)
  --out-md  <path>        write markdown report
  --out-json <path>       write JSON report

Exit code: 0 if every non-skipped check is "ok", 1 otherwise.
`);
}

const args = parseArgs(process.argv.slice(2));

if (!args.adapter) {
  console.error("ERROR: --adapter required");
  printHelp();
  process.exit(2);
}

const exportName = args.exportName ?? "default";
const optsJson   = args.opts ?? process.env["ADAPTER_OPTS_JSON"] ?? "{}";
let ctorOpts: unknown;
try {
  ctorOpts = JSON.parse(optsJson);
} catch (e) {
  console.error(`ERROR: --opts JSON parse failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}

// Dynamic import. Absolute paths work as-is; bare specifiers resolve
// via the consumer's node_modules.
const modSpec = args.adapter.startsWith("/") || args.adapter.startsWith(".")
  ? resolve(process.cwd(), args.adapter)
  : args.adapter;

const mod = await import(modSpec) as Record<string, unknown>;
const Ctor = mod[exportName];
if (typeof Ctor !== "function") {
  console.error(`ERROR: ${modSpec} has no callable export "${exportName}"`);
  process.exit(2);
}

const adapter = new (Ctor as new (opts: unknown) => PlatformAdapter)(ctorOpts);

const runOpts: RunOptions = {};
if (args.skipComplex) runOpts.skipComplex = true;
if (args.skipEvents)  runOpts.skipEvents  = true;
if (typeof args.timeoutMs === "number") runOpts.perCheckTimeoutMs = args.timeoutMs;

console.error(`→ Running conformance against ${modSpec} (export=${exportName})`);
const report = await runConformance(adapter, runOpts);

if (args.outMd)   await writeFile(args.outMd,   mdConformanceReport(report), "utf-8");
if (args.outJson) await writeFile(args.outJson, JSON.stringify(report, null, 2), "utf-8");
process.stdout.write(mdConformanceReport(report));

const failed = report.checks.filter(c => c.status === "fail").length;
console.error(`\n${failed === 0 ? "✓ all checks passed" : `✗ ${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
