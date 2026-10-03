import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { DEFAULT_SKILL_CATALOG_NODE_ID } from "../src/skills/skill_catalog.js";

import {
  ORCH_SERVER_ENVIRONMENT_VARIABLES,
  createApp,
  createEnvironmentConfigProvider,
  loadOrchServerEnvironment,
  parseOrchServerConfig,
  toOrchServerTsConfig,
} from "../src/index.js";

const explicitTestConfig = {
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
};

describe("orch-server-ts config scaffold", () => {
  it("accepts explicit test config without reading production env", () => {
    expect(parseOrchServerConfig(explicitTestConfig)).toEqual({
      ...explicitTestConfig,
      trustProxy: "loopback",
    });
  });

  it("fails fast when a required config value is missing", () => {
    expect(() => parseOrchServerConfig({ ...explicitTestConfig, databaseUrl: "" })).toThrow(
      /databaseUrl/,
    );
  });

  it("maps the supported environment surface and tracks the ignored folder setting", async () => {
    const config = loadOrchServerEnvironment({
      NODE_NAME: "orch-primary",
      HOST: "127.0.0.1",
      PORT: "5300",
      DATABASE_URL: "postgres://orch@localhost/orch",
      DASHBOARD_DIR: "/srv/dashboard",
      DASHBOARD_USER_FOLDER_ACCESS: JSON.stringify({
        " User@Example.com ": {
          restricted: false,
          allowed_folder_ids: [" alpha ", "", 12],
        },
        "legacy@example.com": ["beta"],
      }),
      ATOM_ENABLED: "yes",
      ATOM_SERVER_URL: "https://atom.example.com",
      ATOM_API_KEY: "atom-key",
      ATOM_ROOT_NODE_ID: "root-node",
      AUTH_BEARER_TOKEN: "bearer-token",
      CORS_ALLOWED_ORIGINS: "https://one.example, https://two.example",
      GOOGLE_CLIENT_ID: "google-client",
      GOOGLE_CLIENT_SECRET: "google-secret",
      GOOGLE_CALLBACK_URL: "https://example.com/auth/callback",
      GOOGLE_IOS_CLIENT_ID: "google-ios-client",
      ALLOWED_EMAIL: "user@example.com",
      JWT_SECRET: "jwt-secret",
      ENVIRONMENT: "production",
      CLAUDE_OAUTH_CLIENT_ID: "claude-client",
      CLAUDE_OAUTH_CALLBACK_URL: "https://example.com/claude/callback",
      TURN_SUMMARY_OPENAI_KEY: "turn-summary-key",
      USAGE_SUMMARY_SHARED_ACCOUNTS:
        "claude:eias-linegames-wsl,eiaserinnys;codex:eias-linegames,eias-linegames-wsl,eiaserinnys",
      SOUL_RUNNER_PROCESS_ENABLED: "true",
      SOUL_RUNNER_LEASE_TIMEOUT_MS: "120000",
    });

    expect(config).toEqual({
      mcp_external_ingress_enabled: false, mcp_external_ingress_path: undefined,
      mcp_external_ingress_source: undefined, mcp_external_ingress_display_name: undefined,
      mcp_external_ingress_bearer_token: undefined, mcp_external_events_state_file: undefined,
      mcp_allowed_hosts: ["localhost", "127.0.0.1"],
      node_name: "orch-primary",
      host: "127.0.0.1",
      port: 5300,
      trusted_proxy: "loopback",
      database_url: "postgres://orch@localhost/orch",
      dashboard_dir: "/srv/dashboard",
      dashboard_user_folder_access_configured: true,
      atom_enabled: true,
      atom_server_url: "https://atom.example.com",
      atom_api_key: "atom-key",
      atom_root_node_id: "root-node",
      skill_catalog_node_id: DEFAULT_SKILL_CATALOG_NODE_ID,
      auth_bearer_token: "bearer-token",
      cors_allowed_origins: ["https://one.example", "https://two.example"],
      google_client_id: "google-client",
      google_client_secret: "google-secret",
      google_callback_url: "https://example.com/auth/callback",
      google_ios_client_id: "google-ios-client",
      allowed_email: "user@example.com",
      jwt_secret: "jwt-secret",
      environment: "production",
      claude_oauth_client_id: "claude-client",
      claude_oauth_callback_url: "https://example.com/claude/callback",
      codex_cli_path: null,
      model_catalog_path: null,
      typesafe_api_key: "",
      turn_summary_openai_key: "turn-summary-key",
      usage_summary_poll_interval_seconds: 300,
      usage_summary_shared_accounts: [
        {
          provider: "claude",
          nodeIds: ["eias-linegames-wsl", "eiaserinnys"],
        },
        {
          provider: "codex",
          nodeIds: ["eias-linegames", "eias-linegames-wsl", "eiaserinnys"],
        },
      ],
      soul_runner_process_enabled: true,
      soul_runner_lease_timeout_ms: 120_000,
    });

    expect(toOrchServerTsConfig(config)).toEqual({
      environment: "production",
      databaseUrl: "postgres://orch@localhost/orch",
      authBearerToken: "bearer-token",
      trustProxy: "loopback",
    });
    const provider = createEnvironmentConfigProvider(config);
    await expect(provider.requireConfig("databaseUrl")).resolves.toBe(
      "postgres://orch@localhost/orch",
    );
    await expect(provider.requireConfig("database_url")).resolves.toBe(
      "postgres://orch@localhost/orch",
    );
    await expect(provider.requireConfig("missing_key")).rejects.toThrow(/missing_key/);
  });

  it("ignores legacy board R2 environment credentials", () => {
    const env = { ...minimalEnvironment(), HOST: "127.0.0.1", R2_BOARD_ASSETS_SECRET_ACCESS_KEY: "legacy-secret" };
    const config = loadOrchServerEnvironment(env);
    expect(JSON.stringify(config)).not.toContain("legacy-secret");
    expect(Object.keys(config).some(key => key.startsWith("r2_board_assets_"))).toBe(false);
  });

  it("preserves Python defaults while giving the TS listener port 5200", () => {
    expect(loadOrchServerEnvironment(minimalEnvironment())).toMatchObject({
      node_name: null,
      port: 5200,
      trusted_proxy: "loopback",
      dashboard_dir: "",
      dashboard_user_folder_access_configured: false,
      atom_enabled: false,
      atom_root_node_id: null,
      auth_bearer_token: "",
      cors_allowed_origins: [],
      google_client_id: "",
      jwt_secret: "",
      turn_summary_openai_key: "",
      usage_summary_poll_interval_seconds: 300,
      usage_summary_shared_accounts: [],
      soul_runner_process_enabled: false,
      soul_runner_lease_timeout_ms: 1_800_000,
    });
  });

  it("accepts a positive usage summary polling interval override", () => {
    expect(loadOrchServerEnvironment({
      ...minimalEnvironment(),
      USAGE_SUMMARY_POLL_INTERVAL_SECONDS: "120",
    }).usage_summary_poll_interval_seconds).toBe(120);
    expect(() => loadOrchServerEnvironment({
      ...minimalEnvironment(),
      USAGE_SUMMARY_POLL_INTERVAL_SECONDS: "0",
    })).toThrow(/USAGE_SUMMARY_POLL_INTERVAL_SECONDS/);
  });

  it.each([
    "openai:node-a,node-b",
    "claude:node-a",
    "claude:node-a,,node-b",
    "claude:node-a,node-b;claude:node-b,node-c",
  ])("rejects malformed shared usage account groups: %s", (value) => {
    expect(() => loadOrchServerEnvironment({
      ...minimalEnvironment(),
      USAGE_SUMMARY_SHARED_ACCOUNTS: value,
    })).toThrow(/USAGE_SUMMARY_SHARED_ACCOUNTS/);
  });

  it("configures runner process mode and disconnect grace", () => {
    expect(loadOrchServerEnvironment({
      ...minimalEnvironment(),
      SOUL_RUNNER_PROCESS_ENABLED: "true",
      SOUL_RUNNER_LEASE_TIMEOUT_MS: "90000",
    })).toMatchObject({
      soul_runner_process_enabled: true,
      soul_runner_lease_timeout_ms: 90_000,
    });
    expect(() => loadOrchServerEnvironment({
      ...minimalEnvironment(),
      SOUL_RUNNER_LEASE_TIMEOUT_MS: "0",
    })).toThrow(/SOUL_RUNNER_LEASE_TIMEOUT_MS/);
  });

  it.each([
    "HOST",
    "DATABASE_URL",
    "ENVIRONMENT",
    "CLAUDE_OAUTH_CLIENT_ID",
    "CLAUDE_OAUTH_CALLBACK_URL",
  ])("fails at startup when required env %s is missing", (key) => {
    const env = minimalEnvironment();
    delete env[key];
    expect(() => loadOrchServerEnvironment(env)).toThrow(new RegExp(key));
  });

  it("rejects malformed supported structured and boolean env values explicitly", () => {
    expect(() => loadOrchServerEnvironment({
      ...minimalEnvironment(),
      ATOM_ENABLED: "sometimes",
    })).toThrow(/ATOM_ENABLED/);
    expect(loadOrchServerEnvironment({
      ...minimalEnvironment(),
      DASHBOARD_USER_FOLDER_ACCESS: "not-json",
    }).dashboard_user_folder_access_configured).toBe(true);
    expect(() => loadOrchServerEnvironment({
      ...minimalEnvironment(),
      CORS_ALLOWED_ORIGINS: '["https://ok.example", 3]',
    })).toThrow(/CORS_ALLOWED_ORIGINS/);
  });

  it("preserves the Python production CORS startup guard", () => {
    expect(() => loadOrchServerEnvironment({
      ...minimalEnvironment(),
      ENVIRONMENT: "production",
    })).toThrow(/CORS_ALLOWED_ORIGINS/);
  });

  it("maps the optional Typesafe key independently of Codex and turn summaries", () => {
    const config = loadOrchServerEnvironment({
      ...minimalEnvironment(),
      CODEX_CLI_PATH: "/configured/codex",
      MODEL_CATALOG_PATH: "config/model-catalog.yaml",
      TYPESAFE_API_KEY: "typesafe-key",
      SKILL_CATALOG_NODE_ID: "skill-catalog-node",
    });

    expect(config.codex_cli_path).toBe("/configured/codex");
    expect(config.model_catalog_path).toBe("config/model-catalog.yaml");
    expect(config.typesafe_api_key).toBe("typesafe-key");
    expect(config.skill_catalog_node_id).toBe("skill-catalog-node");
    expect(config.turn_summary_openai_key).toBe("");
  });

  it("requires a production bearer while preserving explicit development unauthenticated mode", () => {
    expect(() => loadOrchServerEnvironment({
      ...minimalEnvironment(),
      ENVIRONMENT: "production",
      CORS_ALLOWED_ORIGINS: "https://dashboard.example",
    })).toThrow(/AUTH_BEARER_TOKEN/);

    expect(loadOrchServerEnvironment({
      ...minimalEnvironment(),
      ENVIRONMENT: "development",
    }).auth_bearer_token).toBe("");

    expect(loadOrchServerEnvironment({
      ...minimalEnvironment(),
      ENVIRONMENT: "production",
      CORS_ALLOWED_ORIGINS: "https://dashboard.example",
      AUTH_BEARER_TOKEN: "service-token",
    }).auth_bearer_token).toBe("service-token");
  });

  it("keeps the checked-in environment reference complete and value-free", () => {
    const entries = readFileSync(new URL("../.env.example", import.meta.url), "utf8")
      .split(/\r?\n/)
      .map((line) => /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null);

    expect(entries.map((match) => match[1]).sort()).toEqual(
      [...ORCH_SERVER_ENVIRONMENT_VARIABLES].sort(),
    );
    expect(entries.every((match) => match[2] === "")).toBe(true);
  });

  it("applies allowed-origin and preflight CORS semantics at the app boundary", async () => {
    const app = createApp({
      config: parseOrchServerConfig(explicitTestConfig),
      corsAllowedOrigins: ["https://dashboard.example"],
    });
    app.get("/cors-check", async () => ({ ok: true }));

    const allowed = await app.inject({
      method: "GET",
      url: "/cors-check",
      headers: { origin: "https://dashboard.example" },
    });
    expect(allowed.headers["access-control-allow-origin"]).toBe(
      "https://dashboard.example",
    );
    expect(allowed.headers["access-control-allow-credentials"]).toBe("true");

    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/cors-check",
      headers: {
        origin: "https://dashboard.example",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization, content-type",
      },
    });
    expect(preflight.statusCode).toBe(200);
    expect(preflight.headers["access-control-allow-methods"]).toContain("GET");
    expect(preflight.headers["access-control-allow-headers"]).toBe(
      "authorization, content-type",
    );

    const denied = await app.inject({
      method: "OPTIONS",
      url: "/cors-check",
      headers: { origin: "https://denied.example" },
    });
    expect(denied.statusCode).toBe(400);

    await app.close();
  });

  it("creates a local-only Fastify app skeleton with an explicit health route", async () => {
    const app = createApp({
      config: parseOrchServerConfig(explicitTestConfig),
      exposeLocalHealthRoute: true,
    });

    const response = await app.inject({ method: "GET", url: "/__orch_server_ts/health" });

    expect(app.initialConfig.forceCloseConnections).toBe(true);
    expect(app.server.requestTimeout).toBe(300_000);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      package: "@soulstream/orch-server-ts",
      environment: "test",
      routeOwnersArtifactOnly: true,
    });

    await app.close();
  });
});

function minimalEnvironment(): Record<string, string> {
  return {
    HOST: "127.0.0.1",
    DATABASE_URL: "postgres://orch@localhost/orch",
    ENVIRONMENT: "test",
    CLAUDE_OAUTH_CLIENT_ID: "claude-client",
    CLAUDE_OAUTH_CALLBACK_URL: "https://example.com/claude/callback",
  };
}
