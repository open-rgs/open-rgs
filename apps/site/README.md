# @open-rgs/site

The open-rgs.schmooky.dev landing + docs site. Astro static build.

```bash
bun install            # from monorepo root
bun run site:dev       # http://localhost:4321
bun run site:build     # → apps/site/dist/
```

## Deploy — Cloudflare Pages (recommended)

The site lives at <https://open-rgs.schmooky.dev>, hosted on
Cloudflare Pages. Auto-deploys on every push to `main`.

**Pages project settings** (set once in dash.cloudflare.com):

| Field | Value |
|---|---|
| Root directory | (empty — repo root) |
| Build command | `bun install && bun --cwd apps/site run build` |
| Build output directory | `apps/site/dist` |
| Framework preset | None |
| Environment variables | `NODE_VERSION=20` |

**Custom domain:** Pages project → Custom domains → `open-rgs.schmooky.dev`.
Since `schmooky.dev` is on Cloudflare DNS, the CNAME is added automatically.

Any other static host (Vercel, Netlify, GitHub Pages, S3+CloudFront)
works — point its build at the same command + output directory.
