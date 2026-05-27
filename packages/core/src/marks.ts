// In-process MarkCollector implementation used by loadLuaMath when
// marks are opted in. The orchestrator never instantiates this — only
// the simulator (or other introspection harnesses) does, by passing
// `{ marks: true }` to loadLuaMath.
//
// A no-op collector is also exported so math files can call host.mark.*
// during normal server runs without conditionally guarding every call.

import type { MarkCollector, MarkSnapshot } from "@open-rgs/contract";

/** Real, in-memory MarkCollector. Cheap; one per math VM. */
export function createMarkCollector(): MarkCollector {
  const counts: Record<string, number> = {};
  const observations: Record<string, number[]> = {};
  const tagSpins: Record<string, number> = {};
  const contributions: Record<string, number> = {};
  let spinTags: Set<string> = new Set();
  let spinsCompleted = 0;
  let inSpin = false;

  return {
    count(name) {
      counts[name] = (counts[name] ?? 0) + 1;
    },
    observe(name, value) {
      (observations[name] ??= []).push(value);
    },
    tag(name) {
      spinTags.add(name);
    },
    contribute(name, multiplier) {
      contributions[name] = (contributions[name] ?? 0) + multiplier;
    },
    beginSpin() {
      if (inSpin) {
        // Reset stale tag state if a prior spin didn't endSpin cleanly.
        spinTags = new Set();
      }
      inSpin = true;
    },
    endSpin() {
      for (const t of spinTags) {
        tagSpins[t] = (tagSpins[t] ?? 0) + 1;
      }
      spinTags = new Set();
      spinsCompleted += 1;
      inSpin = false;
    },
    snapshot(): MarkSnapshot {
      return {
        counts: { ...counts },
        observations: Object.fromEntries(
          Object.entries(observations).map(([k, v]) => [k, [...v]]),
        ),
        tagSpins: { ...tagSpins },
        contributions: { ...contributions },
        spinsCompleted,
      };
    },
  };
}

/** No-op collector. Returned when marks aren't opted in, so math files
 *  that call host.mark.* during normal server runs incur ~zero cost. */
export function noopMarkCollector(): MarkCollector {
  return {
    count() { /* no-op */ },
    observe() { /* no-op */ },
    tag() { /* no-op */ },
    contribute() { /* no-op */ },
    beginSpin() { /* no-op */ },
    endSpin() { /* no-op */ },
    snapshot(): MarkSnapshot {
      return { counts: {}, observations: {}, tagSpins: {}, contributions: {}, spinsCompleted: 0 };
    },
  };
}
