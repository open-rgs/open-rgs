import type { APIRoute } from "astro";

const PATHS = [
  "",
  "overview",
  "build",
  "extend",
  "boot",
  "wire",
  "math",
  "complex",
  "adapter",
  "admin",
  "errors",
];

export const GET: APIRoute = ({ site }) => {
  const base = site ?? new URL("https://open-rgs.schmooky.dev/");
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
