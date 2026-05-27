# Publishing `@open-rgs/*` packages to npm

The 8 packages in `packages/` are MIT and published to the public npm
registry under the `@open-rgs` scope.

> Closed-source / NDA-licensed adapters built against this contract
> are **not** published from this repo and **never** auto-publish from
> any GitHub Action here.

## One-time setup

1. **Claim the `@open-rgs` org on npmjs.org.** Sign in with the owner
   account, create the org (free for public scope packages).
2. **Configure npm Trusted Publisher** (OIDC) for each package, per
   the npm-publish workflow's `environment: npm-publish` binding and
   the workflow filename `.github/workflows/npm-publish.yml`. This
   replaces long-lived `NPM_TOKEN` secrets entirely.
3. **Set up a GitHub Environment** named `npm-publish` on the repo,
   with the publishing account as a required reviewer (optional, but
   recommended).

## Per-package `publishConfig`

Every package's `package.json` carries the minimal block:

```json
"publishConfig": {
  "access": "public",
  "provenance": true
}
```

That's it. No `registry` field — let npm default to
`registry.npmjs.org`. `provenance: true` enables the SLSA attestation
that npm displays on trusted-publisher packages.

## Publish order

When publishing from scratch (or after a contract bump), order
matters because dependents pin exact versions:

```
@open-rgs/contract         ← no @open-rgs deps
@open-rgs/log              ← no @open-rgs deps
@open-rgs/core             ← contract + log
@open-rgs/platform-mock    ← contract
@open-rgs/adapter-kit      ← contract + log
@open-rgs/adapter-test-kit ← contract
@open-rgs/simulator        ← contract
@open-rgs/client           ← contract (+ core/platform-mock/log as devDeps)
```

A `publish.sh` helper at the repo root publishes in this order with
`--dry-run` support.

## Manual local publish (bootstrap only)

The FIRST publish of a brand-new package can only run from a logged-in
local machine — npm's Trusted Publisher binding requires the package
to exist before you can attach a trusted-publisher entry to it. Steps:

```bash
npm login          # 2FA-protected account
./publish.sh       # in-order publish; bumps deps as needed
```

After the first publish, configure Trusted Publishers on every
package's page (`npmjs.com/package/<name>/access`) and switch
subsequent releases to the CI workflow.

## CI publish via OIDC

Every push of a git tag matching `v*` triggers `.github/workflows/npm-publish.yml`.
The workflow:

1. Checks out the code at the tag's SHA
2. Installs Bun
3. Runs typecheck + tests
4. Upgrades npm to ≥ 11.5.1 (Trusted Publisher requires it)
5. Calls `npm publish --access public --provenance` for the packages
   in dependency order

Authentication is fully OIDC — no `NPM_TOKEN` secret in the repo.
