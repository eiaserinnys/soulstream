import { describe, expect, it } from "vitest";

import {
  extractBearerToken,
  verifyServiceBearerAuthorization,
} from "../src/auth/service_bearer.js";

describe("service bearer authorization", () => {
  it("parses the Authorization header in one shared place", () => {
    expect(extractBearerToken("bEaReR   service-token ")).toBe("service-token");
    expect(extractBearerToken(["Basic service-token", "Bearer later-token"]))
      .toBeUndefined();
    expect(extractBearerToken("Bearer token extra")).toBeUndefined();
  });

  it("uses one development bypass and fail-closed production result", () => {
    expect(verifyServiceBearerAuthorization(undefined, "", "development"))
      .toEqual({ ok: true, developmentBypass: true });
    expect(verifyServiceBearerAuthorization(undefined, "", "production"))
      .toEqual({ ok: false, reason: "not_configured", statusCode: 503 });
  });

  it("uses 401 for a configured service token mismatch", () => {
    expect(verifyServiceBearerAuthorization("Bearer wrong", "expected", "production"))
      .toEqual({ ok: false, reason: "invalid", statusCode: 401 });
  });
});
