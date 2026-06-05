// A seedable factory manifest (TS math, no wasmoon) for shard CLI tests.
// Each call to the factory gets a distinct seed, so each shard draws an
// independent mulberry32 substream.
import { mulberry32 } from "../../src/rng.js";
import type { GameManifest, SimpleMath } from "@open-rgs/contract";

export default function build({ seed }: { seed: number }): GameManifest {
  const rng = mulberry32(seed);
  const math: SimpleMath = {
    kind: "simple", name: "shardfix", version: "1.0.0", rtp: 0.5,
    play() {
      const m = rng() < 0.5 ? 1 : 0;
      return { multiplier: m, ops: [], type: m > 0 ? "win" : "loss" };
    },
  };
  return { id: "shardfix", declaredRtp: 0.5, defaultMode: "default", modes: { default: { math, stakeMultiplier: 1 } } };
}
