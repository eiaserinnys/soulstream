import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("v3 task checklist", () => {
  it("uses the section gap as the task workspace bottom inset", () => {
    const css = read("./v3-folder-workspace.css");

    expect(css).toMatch(/\.v3-detail-scroll\s*\{[^}]*padding:\s*24px 24px 28px/s);
    expect(css).not.toContain("padding: 24px 24px 70px");
  });
});
