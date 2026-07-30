import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/production_main.ts"],
  format: ["esm"],
  target: "node20",
  dts: true,
  clean: true,
  // Workspace packages export raw TypeScript and must never remain as runtime imports.
  noExternal: [/^@soulstream\//],
});
