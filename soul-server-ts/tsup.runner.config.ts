import { defineConfig } from "tsup";

export default defineConfig({
  entry: { runner_entry: "src/runner/runner_entry.ts" },
  outDir: "dist/runner",
  format: ["esm"],
  platform: "node",
  target: "node22",
  clean: false,
  splitting: false,
  sourcemap: true,
  banner: {
    js: "import { createRequire as __soulstreamCreateRequire } from 'node:module'; const require = __soulstreamCreateRequire(import.meta.url);",
  },
  // Immutable snapshots contain no node_modules. Bundle every JavaScript
  // runtime dependency; node: built-ins and external Claude/Codex CLIs remain
  // outside the file set by contract.
  noExternal: [/.*/],
});
