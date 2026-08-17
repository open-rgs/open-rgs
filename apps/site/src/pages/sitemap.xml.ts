import type { APIRoute } from "astro";

// Derived from the pages on disk rather than a hand-kept list, because a
// hand-kept list is exactly the thing that silently goes stale: the extension
// routes and /rest were both missing from it before this changed.
const FILES = import.meta.glob("./**/*.astro", { eager: true });

const PATHS = Object.keys(FILES)
  .map((f) => f.replace(/^\.\//, "").replace(/\.astro$/, ""))
  .map((p) => (p === "index" ? "" : p.replace(/\/index$/, "")))
  .sort();

export const GET: APIRoute = ({ site }) => {
  const base = site ?? new URL("https://open-rgs.dev/");
  const urls = PATHS.map((p) => `  <url><loc>${new URL(p, base).toString()}</loc></url>`).join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
  return new Response(xml, {
    status: 200,
    headers: { "content-type": "application/xml; charset=utf-8" },
  });
};
