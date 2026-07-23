import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesEntry = readFileSync(new URL("./v3-dashboard-styles.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("./v3-selection-policy.css", import.meta.url), "utf8");

describe("v3 text selection policy", () => {
  it("loads the semantic selection layer after the visual system", () => {
    expect(stylesEntry.trim().endsWith('import "./v3-selection-policy.css";')).toBe(true);
  });

  it("blocks chrome selection from one root and restores user content", () => {
    expect(css).toMatch(/\.v3-shell\s*\{[^}]*user-select:\s*none/s);
    expect(css).toContain("input");
    expect(css).toContain("textarea");
    expect(css).toContain("[contenteditable=\"true\"]");
    expect(css).toContain("[data-slot=\"chat-body\"]");
    expect(css).toContain("[data-slot=\"chat-tool-body\"]");
    expect(css).toContain("[data-v3-selectable-content=\"true\"]");
    expect(css).toMatch(/user-select:\s*text/);
  });
});
