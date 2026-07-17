import { describe, expect, it } from "vitest";

import { DASHBOARD_PWA_OPTIONS } from "../../pwa-config";

describe("dashboard PWA entry contract", () => {
  it("launches the v3 main route while keeping root-scoped navigation caching", () => {
    expect(DASHBOARD_PWA_OPTIONS.manifest.start_url).toBe("/");
    expect(DASHBOARD_PWA_OPTIONS.workbox?.runtimeCaching).toHaveLength(1);
  });
});
