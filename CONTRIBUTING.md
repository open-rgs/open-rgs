# Contributing to open-rgs

Small, opinionated, rot-resistant  - that's the whole game. Read
[specs/10-design-philosophy.md](specs/10-design-philosophy.md) before
your first PR; it explains *why* the rules below exist.

## Dev loop

```bash
bun install
bun run typecheck
bun test
```

CI gates every PR on: **typecheck + tests + site build +
changeset-check**. Green locally means green in CI.

## The iron rules

- **Spec and code land together.** Spec is source of truth; a PR that
  changes behaviour updates the relevant `specs/*.md` in the same PR.
- **One opinionated way per concern.** No alternative helpers, no
  "pick your favourite." If you need exotic, bring your own outside
  core.
- **No half-features in core.** Either it's done or it's not in.
- **Every dependency needs a justification**  - a comment in
  `package.json` saying why it's there and what it would take to
  remove.
- **Neutral examples only.** Public packages and specs NEVER name a
  real provider's wire shape, brand, or product id. Invented names
  only.

## Money rules

- All amounts are **integers in the currency's minor unit**
  (USD 1.00 -> `100` at `currencyDecimals = 2`). No floats, ever.
- Math is **currency-blind and RNG-injected**: a pure function of
  prior state and injected randomness. It never sees a bet, balance,
  or clock.

## Releases

Releases are driven by [Changesets](https://github.com/changesets/changesets)
with **independent versioning** per package:

- A PR that ships a user-visible change adds a changeset:
  `bun run changeset` (CI rejects `packages/*/src` changes without
  one; `bunx changeset add --empty` for genuinely no-release edits).
- A bot opens a "version packages" PR; maintainers merge it to
  publish. Details in [PUBLISHING.md](PUBLISHING.md).

Docs-only changes (like this file) need no changeset.

## PR etiquette

- **Small PRs, one concern each.** A reviewer should be able to say
  which guarantee or spec a change touches.
- **Behaviour changes come with tests** (`bun:test`).
- **Major decisions get an ADR** in `specs/adr/`.
- **Bigger changes start as a proposal**, not a PR: open an issue per
  "How to propose a change" in
  [specs/09-roadmap.md](specs/09-roadmap.md)  - state the goal, the
  alternatives considered, your recommendation. Implement after the
  spec lands; reviewers check both.

Security issues are different: never a public issue  - see
[SECURITY.md](SECURITY.md).
