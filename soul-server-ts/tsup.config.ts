import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  target: "node20",
  clean: true,
  sourcemap: true,
  // wire-schema는 source 그대로 export하므로 번들에 포함 (workspace 의존)
  noExternal: ["@soulstream/fractional-position", "@soulstream/wire-schema"],
});
