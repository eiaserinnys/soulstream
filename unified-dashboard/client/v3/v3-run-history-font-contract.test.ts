import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CSS_PATH = fileURLToPath(new URL("./v3-run-history.css", import.meta.url));

describe("v3 run history font contract", () => {
  it("matches the corresponding v1 SessionItem font sizes", () => {
    const css = readFileSync(CSS_PATH, "utf8");

    expect(css).toMatch(/\.v3-run-open strong\s*{[^}]*font-size:\s*14\.5px/s);
    expect(css).toMatch(/\.v3-run-agent-line\s*{[^}]*font-size:\s*var\(--font-size-xs\)/s);
    expect(css).toMatch(/\.v3-run-open small\s*{[^}]*font-size:\s*var\(--font-size-sm\)/s);
    expect(css).toMatch(/\.v3-run-trailing time\s*{[^}]*font-size:\s*var\(--font-size-xs\)/s);
  });
});
