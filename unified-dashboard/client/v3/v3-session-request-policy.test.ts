import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const LAYOUT_PATH = fileURLToPath(new URL("./V3DashboardLayout.tsx", import.meta.url));

describe("v3 session request policy", () => {
  it("uses only the planner-targeted session hook", () => {
    const source = readFileSync(LAYOUT_PATH, "utf8");

    expect(source.match(/useSessionListProvider\s*\(/g)).toHaveLength(1);
    expect(source).not.toMatch(/sessionScope\s*:\s*["']all["']/);
    expect(source).toMatch(/sessionIds\s*:\s*plannerSessionIds/);
  });
});
