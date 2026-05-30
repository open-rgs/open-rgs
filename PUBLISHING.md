# Publishing `@open-rgs/*` packages to npm

The 8 packages in `packages/` are MIT and published to the public npm
registry under the `@open-rgs` scope. Releases are driven by
[Changesets](https://github.com/changesets/changesets): you describe
changes in PRs, a bot opens a "version packages" PR, and merging it
publishes.

> Closed-source / NDA-licensed adapters built against this contract
> are **not** published from this repo and **never** auto-publish from
> any GitHub Action here.

## The flow

```
PR with a changeset --merge--> main
                                 |  Release workflow sees pending changesets
                                 v
                    bot opens "chore: version packages" PR
                    (bumps versions, writes CHANGELOGs)
                                 |  you review + merge it
                                 v
                    Release workflow runs `changeset publish`
                    --> npm (OIDC + provenance) + GitHub Releases
```

1. **Add a changeset to any PR that ships a user-visible change.** From
   the repo root:

   ```bash
   bun run changeset
   ```

   Pick the affected packages and the bump type (patch / minor / major),
   write a one-line summary, and commit the generated `.changeset/*.md`.
   `bun run changeset:status` shows what would be released.

2. **Merge the PR.** The [release workflow](.github/workflows/npm-publish.yml)
   runs on `main`. With pending changesets it opens (or updates) a
   **"chore: version packages"** PR that applies the bumps, regenerates
   each affected package's `CHANGELOG.md`, and deletes the consumed
   changeset files.

3. **Merge the "version packages" PR.** The workflow runs again, finds no
   pending changesets, and publishes the bumped packages with
   `changeset publish`  - to npm with provenance, plus a GitHub Release
   per version. Versioning is **independent per package**
   (`.changeset/config.json` -> `fixed: []`); a dependency bump cascades a
   patch to its dependents.

## Authentication  - npm OIDC trusted publishing (no token)

Publishing uses **npm OIDC trusted publishing**; there is no `NPM_TOKEN`
secret. `changesets/action` detects OIDC from the workflow's
`id-token: write` permission and lets `npm publish` do the handshake;
`NPM_CONFIG_PROVENANCE=true` attaches a signed SLSA attestation.

One-time setup on npmjs.com:

1. **Own the `@open-rgs` org** (free for public scope).
2. **Configure a Trusted Publisher for each package**
   (`npmjs.com/package/@open-rgs/<name>/access`) pointing at:
   - org/user: `open-rgs`
   - repository: `open-rgs`
   - workflow: **`npm-publish.yml`**
   - environment: `npm-publish`
3. **Create a GitHub Environment** named `npm-publish` on the repo
   (optionally with the publishing account as a required reviewer).

> The release workflow file is named `npm-publish.yml` on purpose: npm
> OIDC trusted publishing pins the **workflow filename**, and the
> existing Trusted Publisher entries already point at `npm-publish.yml`
> (that's how the 0.x versions were published). Keeping the name means
> no Trusted Publisher change is needed  - the changesets flow inherits
> the proven OIDC identity.

The npm CLI must be >= 11.5.1 for trusted publishing; the workflow
upgrades it (`npm install -g npm@latest`) before publishing.

### Test the publish path without a real release

To exercise the full OIDC + provenance + `changeset publish` path
without touching `latest` or burning a real version, run the release
workflow manually with the **`snapshot`** input
(`Actions -> Release -> Run workflow -> snapshot: true`). It runs
`bun run snapshot`, which stamps throwaway `0.0.0-snapshot-<timestamp>`
versions and publishes them under the `snapshot` dist-tag. Install one
with `npm i @open-rgs/<name>@snapshot`. `latest` and the real `1.0.0`
are untouched; snapshot versions can be left or `npm unpublish`ed.

## Per-package `publishConfig`

Every package's `package.json` carries:

```json
"publishConfig": {
  "access": "public",
  "provenance": true
}
```

No `registry` field  - npm defaults to `registry.npmjs.org`.

## Manual publish (emergency / first bootstrap only)

CI is the only routine path. If you ever must publish by hand  - e.g. the
very first publish of a brand-new package name, which can't use a Trusted
Publisher until the package exists  - log in and run `changeset publish`
directly:

```bash
npm login          # 2FA-protected account with publish rights to @open-rgs
bun install
bun run release    # = changeset publish; skips versions already on npm
```

Provenance is CI-only (it needs an OIDC issuer), so a manual publish ships
without it; the next CI release re-establishes provenance.
