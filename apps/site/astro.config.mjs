import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://open-rgs.schmooky.dev",
  trailingSlash: "ignore",
  build: {
    format: "directory",
  },
});
