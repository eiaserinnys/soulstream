import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/production_main.ts"],
  format: ["esm"],
  target: "node20",
  dts: true,
  clean: true,
  noExternal: [
    "@soulstream/fractional-position",
    "@soulstream/page-model",
  ],
});
