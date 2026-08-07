import path from "node:path";
import mdx from "@mdx-js/rollup";
import react from "@vitejs/plugin-react";
import rehypeSlug from "rehype-slug";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    {
      enforce: "pre",
      ...mdx({ include: /\.mdx$/, rehypePlugins: [rehypeSlug] }),
    },
    react({ include: /\.(jsx|js|mdx|md|tsx|ts)$/ }),
  ],
  resolve: {
    alias: {
      "#": path.resolve(__dirname, "src"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: [path.resolve(__dirname, "src/test-setup.ts")],
  },
});
