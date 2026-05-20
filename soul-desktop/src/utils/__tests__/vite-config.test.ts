import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const configPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../vite.config.ts",
);

describe("vite config", () => {
  it("builds relative asset URLs for the packaged Tauri app", () => {
    expect(readFileSync(configPath, "utf8")).toContain('base: "./"');
  });
});
