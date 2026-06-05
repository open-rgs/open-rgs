// A STATIC manifest (not a factory): all shards would draw the identical
// stream, so the CLI must refuse to shard it. Used by the fail-closed test.
import { mulberry32 } from "../../src/rng.js";
import type { GameManifest, SimpleMath } from "@open-rgs/contract";

const rng = mulberry32(123);
const math: SimpleMath = {
  kind: "simple", name: "staticfix", version: "1.0.0", rtp: 0.5,
  play() {
    const m = rng() < 0.5 ? 1 : 0;
    return { multiplier: m, ops: [], type: m > 0 ? "win" : "loss" };
  },
};

const manifest: GameManifest = { id: "staticfix", declaredRtp: 0.5, defaultMode: "default", modes: { default: { math, stakeMultiplier: 1 } } };
export default manifest;
