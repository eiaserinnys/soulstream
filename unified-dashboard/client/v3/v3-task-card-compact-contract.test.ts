import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("v3 task card compact contract", () => {
  it("shrinks the minimum height after metadata removal", () => {
    const css = readFileSync(new URL("./v3-planner-surfaces.css", import.meta.url), "utf8");
    const taskCardRule = css.match(/\.v3-task-card\s*\{(?<body>[^}]*)\}/)?.groups?.body ?? "";

    expect(taskCardRule).toMatch(/min-height:\s*96px/);
  });
});
