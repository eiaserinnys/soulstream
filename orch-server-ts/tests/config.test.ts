import { describe, expect, it } from "vitest";

import {
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
      boardYjsHostMode: "node",
      trustProxy: "loopback",
    });
  });

  it("fails fast when a required config value is missing", () => {
    expect(() => parseOrchServerConfig({ ...explicitTestConfig, databaseUrl: "" })).toThrow(
      /databaseUrl/,
    );
  });

  it("maps the complete Python Settings env surface and fixes JSON/CSV parsing", async () => {
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
      R2_BOARD_ASSETS_ACCESS_KEY_ID: "r2-access",
      R2_BOARD_ASSETS_SECRET_ACCESS_KEY: "r2-secret",
      R2_BOARD_ASSETS_BUCKET: "r2-bucket",
      R2_BOARD_ASSETS_ENDPOINT: "https://r2.example.com",
      ATOM_ENABLED: "yes",
      ATOM_SERVER_URL: "https://atom.example.com",
      ATOM_API_KEY: "atom-key",
      ATOM_ROOT_NODE_ID: "root-node",
      AUTH_BEARER_TOKEN: "bearer-token",
      BOARD_YJS_HOST_MODE: "orch",
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
    });

    expect(config).toEqual({
      node_name: "orch-primary",
      host: "127.0.0.1",
      port: 5300,
      trusted_proxy: "loopback",
      database_url: "postgres://orch@localhost/orch",
      dashboard_dir: "/srv/dashboard",
      dashboard_user_folder_access: {
        "user@example.com": {
          restricted: false,
          allowedFolderIds: ["alpha", "12"],
        },
        "legacy@example.com": {
          restricted: true,
          allowedFolderIds: ["beta"],
        },
      },
      r2_board_assets_access_key_id: "r2-access",
      r2_board_assets_secret_access_key: "r2-secret",
      r2_board_assets_bucket: "r2-bucket",
      r2_board_assets_endpoint: "https://r2.example.com",
      atom_enabled: true,
      atom_server_url: "https://atom.example.com",
      atom_api_key: "atom-key",
      atom_root_node_id: "root-node",
      auth_bearer_token: "bearer-token",
      board_yjs_host_mode: "orch",
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
    });

    expect(toOrchServerTsConfig(config)).toEqual({
      environment: "production",
      databaseUrl: "postgres://orch@localhost/orch",
      authBearerToken: "bearer-token",
      boardYjsHostMode: "orch",
      trustProxy: "loopback",
      r2_board_assets_access_key_id: "r2-access",
      r2_board_assets_secret_access_key: "r2-secret",
      r2_board_assets_bucket: "r2-bucket",
      r2_board_assets_endpoint: "https://r2.example.com",
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

  it("preserves Python defaults while giving the TS listener port 5200", () => {
    expect(loadOrchServerEnvironment(minimalEnvironment())).toMatchObject({
      node_name: null,
      port: 5200,
      trusted_proxy: "loopback",
      dashboard_dir: "",
      dashboard_user_folder_access: {},
      r2_board_assets_access_key_id: "",
      atom_enabled: false,
      atom_root_node_id: null,
      auth_bearer_token: "",
      board_yjs_host_mode: "node",
      cors_allowed_origins: [],
      google_client_id: "",
      jwt_secret: "",
    });
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

  it("rejects malformed structured and boolean env values explicitly", () => {
    expect(() => loadOrchServerEnvironment({
      ...minimalEnvironment(),
      ATOM_ENABLED: "sometimes",
    })).toThrow(/ATOM_ENABLED/);
    expect(() => loadOrchServerEnvironment({
      ...minimalEnvironment(),
      DASHBOARD_USER_FOLDER_ACCESS: "[]",
    })).toThrow(/DASHBOARD_USER_FOLDER_ACCESS/);
    expect(() => loadOrchServerEnvironment({
      ...minimalEnvironment(),
      CORS_ALLOWED_ORIGINS: '["https://ok.example", 3]',
    })).toThrow(/CORS_ALLOWED_ORIGINS/);
    expect(() => loadOrchServerEnvironment({
      ...minimalEnvironment(),
      BOARD_YJS_HOST_MODE: "worker",
    })).toThrow(/BOARD_YJS_HOST_MODE/);
  });

  it("preserves the Python production CORS startup guard", () => {
    expect(() => loadOrchServerEnvironment({
      ...minimalEnvironment(),
      ENVIRONMENT: "production",
    })).toThrow(/CORS_ALLOWED_ORIGINS/);
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
