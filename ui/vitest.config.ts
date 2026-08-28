import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { createMdxPlugin } from "./mdx-plugin";

export default defineConfig({
  plugins: [createMdxPlugin(), react({ include: /\.(jsx|js|mdx|md|tsx|ts)$/ })],
  resolve: {
    alias: {
      "#": path.resolve(__dirname, "src"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    // A jsdom render driven through React Aria and userEvent is slow enough
    // that the 5s default failed on load, not on defects.
    testTimeout: 15000,
    setupFiles: [path.resolve(__dirname, "src/test-setup.ts")],
  },
});
