import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

function extractCssBlock(css: string, marker: string): string {
  const start = css.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);

  const openBrace = css.indexOf("{", start);
  expect(openBrace).toBeGreaterThanOrEqual(0);

  let depth = 0;
  for (let index = openBrace; index < css.length; index += 1) {
    const char = css[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(start, index + 1);
    }
  }

  throw new Error(`CSS block not closed: ${marker}`);
}

describe("card running glow CSS", () => {
  it("keeps running backgrounds anchored to the opaque card surface", () => {
    const globalsCss = readFileSync(new URL("./globals.css", import.meta.url), "utf8");

    for (const keyframeName of [
      "card-running-breathe",
      "card-running-breathe-tint",
      "card-running-breathe-active",
    ]) {
      const keyframes = extractCssBlock(globalsCss, `@keyframes ${keyframeName}`);
      const backgroundColorLines = keyframes
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("background-color:"));

      expect(keyframes).not.toMatch(/\bopacity\s*:/);
      expect(backgroundColorLines.length).toBeGreaterThan(0);
      for (const line of backgroundColorLines) {
        expect(line).toContain("var(--card)");
        expect(line).not.toContain("transparent");
      }
    }
  });
});
