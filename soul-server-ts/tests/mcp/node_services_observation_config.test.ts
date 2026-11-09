import { describe, expect, it } from "vitest";

import { resolveNodeServicesObservation } from "../../src/mcp/node_services_observation_config.js";

describe("resolveNodeServicesObservation", () => {
  it("returns undefined when no endpoint pair is configured", () => {
    expect(resolveNodeServicesObservation({})).toBeUndefined();
  });

  it("builds an endpoint only when both members of the pair exist", () => {
    expect(resolveNodeServicesObservation({
      HANIEL_DASHBOARD_URL: "http://127.0.0.1:9300",
    })).toBeUndefined();
    expect(resolveNodeServicesObservation({
      HANIEL_ORCH_TOKEN_FILE: "/run/secrets/orch",
    })).toBeUndefined();
    expect(resolveNodeServicesObservation({
      HANIEL_DASHBOARD_URL: "http://127.0.0.1:9300",
      HANIEL_DASHBOARD_TOKEN_FILE: "/run/secrets/dashboard",
      HANIEL_ORCH_TOKEN_FILE: "/run/secrets/orch",
    })).toEqual({
      dashboard: {
        baseUrl: "http://127.0.0.1:9300",
        tokenFile: "/run/secrets/dashboard",
      },
    });
  });

  it("keeps both endpoints when both pairs are complete", () => {
    expect(resolveNodeServicesObservation({
      HANIEL_DASHBOARD_URL: "http://127.0.0.1:9300",
      HANIEL_DASHBOARD_TOKEN_FILE: "/run/secrets/dashboard",
      HANIEL_ORCH_URL: "http://127.0.0.1:9400",
      HANIEL_ORCH_TOKEN_FILE: "/run/secrets/orch",
    })).toEqual({
      dashboard: {
        baseUrl: "http://127.0.0.1:9300",
        tokenFile: "/run/secrets/dashboard",
      },
      orch: {
        baseUrl: "http://127.0.0.1:9400",
        tokenFile: "/run/secrets/orch",
      },
    });
  });
});
