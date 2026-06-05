# @open-rgs/core

The orchestrator and runtime for [open-rgs](https://open-rgs.dev) - the
round lifecycle, money-movement choreography, math runtimes, secure RNG,
binary-msgpack transport, admin endpoints, and metrics. With
`@open-rgs/contract` it is the only required package.

**Bun is required.** This package publishes raw TypeScript (no `dist/`) and
leans on Bun-specific APIs; run it under Bun, not Node.

## Install

```bash
bun add @open-rgs/core @open-rgs/contract @open-rgs/platform-mock
```

## Boot

```ts
import { createServer, binaryTransport, loadLuaMath } from "@open-rgs/core";
import { defineGame } from "@open-rgs/contract";
import { MockPlatform } from "@open-rgs/platform-mock";

await createServer({
  manifest: defineGame({
    id: "hello", declaredRtp: 0.95, defaultMode: "default",
    modes: { default: { math: await loadLuaMath("./maths/spin.lua"), stakeMultiplier: 1 } },
  }),
  platform:  new MockPlatform({ startingBalance: 100_000 }),
  transport: binaryTransport({ port: 80 }),
});
```

## Math runtimes

A game's math is a `MathModule` (`@open-rgs/contract`). Core loads it from
one of three source forms - same contract, swappable by a manifest entry:

| Loader | Source | Use case |
|--------|--------|----------|
| `loadLuaMath(path, opts?)` | `.lua` via wasmoon (Lua 5.4 -> WASM) | Default. Cheap to write, hot-reloadable. Per-call watchdog (`debug.sethook`). |
| `loadWasmMath(path, opts?)` | `.wasm` kernel (typically **Zig** or Rust) | Production-grade, certification-friendly, ~15x faster than Lua. Simple math only. |
| `createMathPool(opts)` | the same `.wasm` kernel, in a Worker pool | The **fail-closed** way to run WASM math: per-call timeout enforced by `terminate()`. |

### Compiled (WASM / Zig) math

Author a kernel (exports `play` / `alloc` / `free`, imports `host.rng_next`;
see `examples/hold-and-win/maths/play.zig` for a worked one) and build it to
WASM with zig:

```bash
zig build-exe play.zig -target wasm32-freestanding -fno-entry -rdynamic \
  -OReleaseSmall -femit-bin=play.wasm
```

Then load it:

```ts
import { loadWasmMath, cryptoRng } from "@open-rgs/core";

// Direct, synchronous calls - the fast path.
const math = await loadWasmMath("./maths/play.wasm", { rng: cryptoRng });
```

A WASM call cannot be interrupted from JS, so `loadWasmMath` has **no
execution watchdog** - a runaway kernel would block the event loop. It logs
a warning at load to keep that visible. Use it only for trusted, bounded
kernels.

For unbounded or untrusted WASM math, run it through the worker pool:

```ts
import { createMathPool } from "@open-rgs/core";

const math = await createMathPool({
  wasmPath:  "./maths/play.wasm",
  size:      4,      // worker threads (default 4)
  timeoutMs: 1000,   // per-call budget; an overrun is killed via terminate()
});
// ...later: math.shutdown();
```

The pool runs the kernel on Worker threads (off the I/O thread) and **kills**
any worker that overruns the budget, failing the round with `MATH_TIMEOUT` and
replacing the worker. This is the WASM tier's enforcement of Guarantee 5
(Fail Closed / no-DoS). v1 is simple (single `play`) math.

Why Zig for kernels: comptime RTP invariants, no GC pauses, no JIT warmup,
tiny hashable output, and one source that compiles to **both** WASM (server)
and a native binary (simulator) - byte-for-byte identical. See
[`specs/06-performance.md`](../../specs/06-performance.md) and the worked
`examples/hold-and-win` (a 3x3 hold-&-win on a Zig kernel).

## Secure RNG

Outcome randomness is injected by the host; the math never ships its own PRNG.

- **Default is a secure CSPRNG.** `cryptoRng` (exported) draws from WebCrypto
  `getRandomValues` (-> BoringSSL/OpenSSL, the same source Bun's `crypto`
  uses). `Math.random` is **never** used for outcomes.
- **Production fails closed.** Under `NODE_ENV=production`, a loader with no
  `rng` injected **throws** - even though a secure default exists - so the
  operator chooses the source deliberately. Pass `{ rng: cryptoRng }` for the
  system CSPRNG, or inject a jurisdiction-certified source.
- A seeded PRNG (e.g. `mulberry32` from `@open-rgs/simulator`) is for
  simulation only; it is tagged and **refused** in production.

```ts
import { loadLuaMath, cryptoRng } from "@open-rgs/core";

// Production: choose the RNG explicitly.
const math = await loadLuaMath("./maths/spin.lua", { rng: cryptoRng });
```

## Also exported

`createOrchestrator` (drive rounds without a transport), `binaryTransport`,
`startAdmin` + admin/probe handlers, `createAuditLog` / `verifyChain` (hash-
chained audit log), `createRgsMetrics` + a Prometheus-style `Registry`,
`settleAmount` / `roundHalfEven` (integer minor-unit money), `uuidV4` /
`deriveIdempotencyKey`, `cryptoRng`, and the `session` / `promo` namespaces.

## Specs

The contracts and guarantees this package enforces:
[00-guarantees](../../specs/00-guarantees.md),
[02-orchestrator](../../specs/02-orchestrator.md),
[03-math-runtime](../../specs/03-math-runtime.md),
[06-performance](../../specs/06-performance.md).

## License

MIT.
