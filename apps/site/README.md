# @open-rgs/site

The open-rgs.dev landing + docs site. Astro static build.

```bash
bun install            # from monorepo root
bun run site:dev       # http://localhost:4321
bun run site:build     # -> apps/site/dist/
```

## Deploy  - Timeweb Cloud Apps

Hosted at <https://open-rgs.dev>. Auto-deploys on every push to `main`.

**App settings** (set once in `timeweb.cloud/services/apps`):

| Field | Value |
|---|---|
| Framework | Static site |
| Source | GitHub -> `open-rgs/open-rgs` (branch `main`) |
| Root directory | `/` (repo root) |
| Build command | `npm install -g bun && bun install && bun run --filter @open-rgs/site build` |
| Output directory | `apps/site/dist` |
| Node.js version | 20 LTS |

Timeweb's runner doesn't ship Bun by default; the build command
installs it globally first, then uses it for the rest. The site
itself is pure Astro static  - no runtime dep on Bun.

**Custom domain:** App settings -> Domains -> add `open-rgs.dev`.
Timeweb will give you the target hostname (e.g. `<app>.twc1.net`).
Point `open-rgs.dev` at it via DNS:

| Type | Name | Value |
|---|---|---|
| A | `@` | (Timeweb's app IP, shown in dashboard) |
| CNAME | `www` | `open-rgs.dev` |

TLS is auto-provisioned by Timeweb (Let's Encrypt).

Any other static host (Cloudflare Pages, Vercel, Netlify, GitHub
Pages, S3+CloudFront) works  - point its build at the same command +
output directory.
