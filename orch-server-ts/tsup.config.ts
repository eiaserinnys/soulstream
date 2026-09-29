import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    production_main: "src/production_main.ts",
    folder_storage_migration_cli: "src/folders/folder_storage_migration_cli.ts",
  },
  format: ["esm"],
  target: "node22",
  dts: true,
  clean: true,
  // Workspace packages export raw TypeScript and must never remain as runtime imports.
  noExternal: [/^@soulstream\//],
});
