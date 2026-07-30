import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  target: "node20",
  clean: true,
  sourcemap: true,
  // Workspace packages export raw TypeScript and must never remain as runtime imports.
  noExternal: [/^@soulstream\//],
});
