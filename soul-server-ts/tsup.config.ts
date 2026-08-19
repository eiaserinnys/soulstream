import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/main.ts",
    "src/runner/runner_release_prewarm.ts",
    "src/upstream/control_inbox_worker_entry.ts",
  ],
  format: ["esm"],
  target: "node22",
  clean: true,
  sourcemap: true,
  // Workspace packages export raw TypeScript and must never remain as runtime imports.
  noExternal: [/^@soulstream\//],
});
