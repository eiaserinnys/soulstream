import { describe, expect, it } from "vitest";

import { resolveOrchestratorDashboardVersion } from "../dashboard-routes";

describe("resolveOrchestratorDashboardVersion", () => {
  it("serves v3 from the main route and v1 only from the explicit legacy family", () => {
    expect(resolveOrchestratorDashboardVersion("/")).toBe("v3");
    expect(resolveOrchestratorDashboardVersion("/session-1")).toBe("v3");
    expect(resolveOrchestratorDashboardVersion("/v1")).toBe("v1");
    expect(resolveOrchestratorDashboardVersion("/v1/session-1")).toBe("v1");
    expect(resolveOrchestratorDashboardVersion("/v1-other")).toBe("v3");
  });
});
