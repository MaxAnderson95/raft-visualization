import { defineConfig } from "vite-plus";

// Config runs in Node; declare just what we read (no @types/node needed).
declare const process: { env: Record<string, string | undefined> };

export default defineConfig({
  // Project Pages serve from /<repo>/; CI sets GITHUB_PAGES, dev stays at root.
  base: process.env.GITHUB_PAGES ? "/raft-visualization/" : "/",
  fmt: {},
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
});
