import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const E2E_DIRECTORY = fileURLToPath(new URL("../e2e/", import.meta.url));
const HARNESS_FILE = "playwright-lifecycle-harness.mjs";
const SOURCE_EXTENSIONS = new Set([".cjs", ".js", ".mjs", ".ts", ".tsx"]);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return SOURCE_EXTENSIONS.has(extname(entry.name)) ? [path] : [];
  });
}

describe("standalone Playwright source policy", () => {
  it("keeps direct Chromium launch in the lifecycle harness only", () => {
    const directLaunches = sourceFiles(E2E_DIRECTORY).flatMap((path) => {
      const matches = readFileSync(path, "utf8").match(/chromium\.launch\s*\(/g) ?? [];
      return matches.map(() => relative(E2E_DIRECTORY, path));
    });

    expect(directLaunches).toEqual([HARNESS_FILE]);
  });

  it("loads Playwright only inside the default launcher fallback", () => {
    const harnessSource = readFileSync(join(E2E_DIRECTORY, HARNESS_FILE), "utf8");

    expect(harnessSource).toContain('await import("playwright")');
    expect(harnessSource).not.toMatch(/^import\s+.+\s+from\s+["']playwright["'];?$/m);
  });
});
