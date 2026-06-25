import { describe, expect, it } from "vitest";

import { WEBGL_GLASS_FRAGMENT_SHADER } from "./webgl-glass-shaders";

describe("WEBGL_GLASS_FRAGMENT_SHADER", () => {
  it("keeps refraction local to the rounded edge instead of scaling with panel area", () => {
    expect(WEBGL_GLASS_FRAGMENT_SHADER).toContain("float edgeBand=min(min(hsz.x,hsz.y), max(48.0, R*3.0));");
    expect(WEBGL_GLASS_FRAGMENT_SHADER).toContain("vec2 normal=roundNormal(lp,hsz,R);");
    expect(WEBGL_GLASS_FRAGMENT_SHADER).toContain("fragPx-normal*(edgeAmt*edgeBand)");
    expect(WEBGL_GLASS_FRAGMENT_SHADER).not.toContain("inside/min(hsz.x,hsz.y)");
    expect(WEBGL_GLASS_FRAGMENT_SHADER).not.toContain("center+pn*factor*hsz");
  });
});
