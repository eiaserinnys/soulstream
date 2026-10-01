import { readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vitest";

it("keeps row inset, tracks and cap dimensions in the frame stylesheet", () => {
  const violations: string[] = [];
  for (const file of readdirSync("client/v3").filter(file => file.endsWith(".css") && file !== "v3-run-history.css")) {
    const css = readFileSync(`client/v3/${file}`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selectors = match[1].split(",").filter(selector => /\.v3-run-(?:open|avatar|copy|identity|affiliation|title-line|agent-line|trailing|row-actions)\b|\.v3-task-(?:card|star-toggle)\b/.test(selector));
      if (selectors.length && /(?:^|;)\s*(?:padding(?:-[\w]+)?|margin(?:-[\w]+)?|gap|row-gap|column-gap|(?:min-|max-)?(?:height|width)|grid-[\w-]+|font(?:-[\w]+)?|line-height)\s*:/.test(match[2])) violations.push(`${file}: ${selectors.join(",")}`);
    }
  }
  expect(violations).toEqual([]);
});
