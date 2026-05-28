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

## Docs

Full reference: <https://open-rgs.dev>

## License

MIT  - © open-rgs contributors
