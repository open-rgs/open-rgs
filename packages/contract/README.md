# @open-rgs/contract

Public type contracts for [open-rgs](https://github.com/open-rgs/open-rgs).
Zero runtime. Zero deps.

The contract surface every part of an Open-RGS system targets:

| Implementer | Implements |
|---|---|
| Math author | `MathModule` (simple / complex) |
| Operator integrator | `PlatformAdapter` |
| Transport author | `ClientTransport` |
| Game integrator | composes via `defineGame()` |

## Install

```bash
bun add @open-rgs/contract
```

## Canonical ops (opt in)

`Op` is `unknown` in the core contract: math authors define their own visual
instructions and the engine only forwards them. `@open-rgs/contract/ops` is
the opt-in middle ground: nine shapes a generic client can render.

```ts
import { canonicalOps, opsTotal, type CanonicalOp } from "@open-rgs/contract/ops";

const drawable = canonicalOps(res.ops);
const shown = opsTotal(res.ops);
```

`board`, `win`, `cascade`, `respin`, `coin`, `award`, `feature`, `meter`,
`message`. Emit them and any client that understands them, including
`UniversalClient` in `@open-rgs/client`: can drive your game. Ignore them
and nothing changes: core never reads ops, and this module is types plus a
type guard.

Ops are a visual log, not a settlement record. The round's `multiplier` is
what pays. `opsTotal` is for CHECKING a presentation against that multiplier
in a test; a mismatch is a presentation bug, never a reason to move money.

## Docs

Full reference: <https://open-rgs.dev>

## License

MIT: © open-rgs contributors
