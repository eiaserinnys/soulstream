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

  it("builds the orch endpoint from the vault env file source", () => {
    expect(resolveNodeServicesObservation({
      HANIEL_ORCH_URL: "http://127.0.0.1:9400",
      HANIEL_ORCH_VAULT_ENV_FILE: "/home/eias/.local/share/haniel/vault.env",
    })).toEqual({
      orch: {
        baseUrl: "http://127.0.0.1:9400",
        vaultEnvFile: "/home/eias/.local/share/haniel/vault.env",
      },
    });
  });

  it("does not build the orch endpoint without exactly one token source", () => {
    expect(resolveNodeServicesObservation({
      HANIEL_ORCH_VAULT_ENV_FILE: "/home/eias/.local/share/haniel/vault.env",
    })).toBeUndefined();
    expect(resolveNodeServicesObservation({
      HANIEL_ORCH_URL: "http://127.0.0.1:9400",
      HANIEL_ORCH_TOKEN_FILE: "/run/secrets/orch",
      HANIEL_ORCH_VAULT_ENV_FILE: "/home/eias/.local/share/haniel/vault.env",
    })).toBeUndefined();
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
