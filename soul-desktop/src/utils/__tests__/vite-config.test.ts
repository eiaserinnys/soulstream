// @vitest-environment node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const configPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../vite.config.ts",
);
const desktopRoot = dirname(configPath);

describe("vite config", () => {
  it("builds relative asset URLs for the packaged Tauri app", () => {
    expect(readFileSync(configPath, "utf8")).toContain('base: "./"');
  });

  it("uses Cargo as the only desktop version source", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(desktopRoot, "package.json"), "utf8"),
    ) as { version?: string };
    const tauriConfig = JSON.parse(
      readFileSync(resolve(desktopRoot, "src-tauri/tauri.conf.json"), "utf8"),
    ) as { version?: string };
    const cargoToml = readFileSync(
      resolve(desktopRoot, "src-tauri/Cargo.toml"),
      "utf8",
    );

    expect(packageJson.version).toBeUndefined();
    expect(tauriConfig.version).toBeUndefined();
    expect(cargoToml).toMatch(/^version = "\d+\.\d+\.\d+"/m);
  });
});
