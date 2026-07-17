import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("v3 daily first-surface policy", () => {
  it("removes the compact memo resize handle while preserving content-driven height", () => {
    const styles = read("./v3-task-workspace.css");

    expect(styles).toMatch(
      /\.v3-description-editor\[data-editor-variant="daily"\] textarea\s*\{[\s\S]*?resize:\s*none;[\s\S]*?overflow-y:\s*hidden;/,
    );
    expect(styles).toMatch(
      /\.v3-description-editor\[data-editor-variant="compact"\] textarea,\s*\.v3-description-editor\[data-editor-variant="daily"\] textarea\s*\{[\s\S]*?min-height:\s*82px;/,
    );
  });

  it("pins both daily headings to the left edge", () => {
    const styles = read("./v3-planner.css");

    expect(styles).toMatch(
      /\.v3-date-head\s*\{[\s\S]*?justify-content:\s*flex-start;[\s\S]*?text-align:\s*left;/,
    );
    expect(styles).toMatch(
      /\.v3-section-head\s*\{[\s\S]*?justify-content:\s*flex-start;[\s\S]*?text-align:\s*left;/,
    );
  });
});
