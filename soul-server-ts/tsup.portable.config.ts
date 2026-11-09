import { defineConfig } from "tsup";

/**
 * Node-portable payload: the same host entries as `tsup.config.ts`, plus the
 * node-side bind CLI, with every JavaScript runtime dependency inlined so the
 * unpacked directory runs without node_modules. Output is deliberately separate
 * from `dist/` — the existing build and its release manifest stay untouched.
 */
const requireBanner =
  "import { createRequire as __soulstreamCreateRequire } from 'node:module'; const require = __soulstreamCreateRequire(import.meta.url);";

export default defineConfig([
  {
    entry: [
      "src/main.ts",
      "src/runner/runner_release_prewarm.ts",
      "src/upstream/control_inbox_worker_entry.ts",
    ],
    outDir: "dist-portable",
    format: ["esm"],
    platform: "node",
    target: "node22",
    clean: true,
    sourcemap: false,
    banner: { js: requireBanner },
    noExternal: [/.*/],
  },
  {
    entry: { "bind-release": "src/release/bind_release_entry.ts" },
    outDir: "dist-portable",
    format: ["esm"],
    platform: "node",
    target: "node22",
    clean: false,
    splitting: false,
    sourcemap: false,
    outExtension: () => ({ js: ".mjs" }),
    banner: { js: requireBanner },
    noExternal: [/.*/],
  },
]);
