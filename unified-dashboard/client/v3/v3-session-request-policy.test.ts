import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const LAYOUT_PATH = fileURLToPath(new URL("./V3DashboardLayout.tsx", import.meta.url));
const LIVE_PLANE_PATH = fileURLToPath(new URL("./use-v3-live-data-plane.ts", import.meta.url));

describe("v3 session request policy", () => {
  it("uses only the planner-targeted session hook", () => {
    const layoutSource = readFileSync(LAYOUT_PATH, "utf8");
    const planeSource = readFileSync(LIVE_PLANE_PATH, "utf8");

    expect(layoutSource).toMatch(/useV3LiveDataPlane\s*\(/);
    expect(layoutSource).toMatch(/sessionIds\s*:\s*plannerSessionIds/);
    expect(planeSource.match(/useSessionListProvider\s*\(/g)).toHaveLength(1);
    expect(planeSource).toMatch(/sessionIds,/);
    expect(`${layoutSource}\n${planeSource}`).not.toMatch(/sessionScope\s*:\s*["']all["']/);
  });
});
