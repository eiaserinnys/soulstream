import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  registerAgentProfileRoutes,
  type AgentProfileRecord,
  type AgentProfileRepository,
} from "../src/node/agent_profile_routes.js";
import { registerNodeBootstrapRoutes } from "../src/node_bootstrap/node_bootstrap_routes.js";
import {
  PortableConfigService,
  type PortableConfigServiceOptions,
} from "../src/node_bootstrap/portable_config_service.js";
import type { NodeCredentialResolver } from "../src/node_credentials/types.js";
import {
  FIXTURE_KIMI_KEY_VALUE,
  FIXTURE_OPENCODE_KEY_VALUE,
  FIXTURE_SERVING_COMMIT,
  FIXTURE_SOULSTREAM_TOKEN,
  createPortableFixture,
  writePortableFixtureFiles,
  type PortableFixtureFiles,
} from "./portable-config-fixture.js";

const COMMON_TOKEN = "common-service-token";
const principals = new Map([
  ["node-token", { credential_id: "credential-personal", node_id: "node-personal", company_pc: false }],
  ["company-token", { credential_id: "credential-company", node_id: "node-company", company_pc: true }],
]);
const nodeCredentials: NodeCredentialResolver = {
  resolve: (token) => principals.get(token) ?? null,
  onRevoked: () => () => undefined,
};

const runtimeProfiles: AgentProfileRecord[] = [
  runtimeProfile("agent-a", "preset-claude-a"),
  runtimeProfile("agent-b", "preset-untrusted-a"),
  runtimeProfile("agent-h", "preset-claude-a"),
];

let files: PortableFixtureFiles;
let untrustedFiles: PortableFixtureFiles;
let service: PortableConfigService;
let bootstrapApp: FastifyInstance;
let companyBlockApp: FastifyInstance;
let untrustedApp: FastifyInstance;
let disabledApp: FastifyInstance;
let unavailableApp: FastifyInstance;
let runtimePortableApp: FastifyInstance;
let runtimePlainApp: FastifyInstance;
let runtimeDisabledApp: FastifyInstance;

beforeAll(async () => {
  files = await writePortableFixtureFiles();
  const fixture = createPortableFixture();
  untrustedFiles = await writePortableFixtureFiles({
    modelCatalog: {
      presets: (fixture.modelCatalog as { presets: Array<Record<string, unknown>> }).presets.map(
        (preset) => ({ ...preset, trusted_execution: false }),
      ),
    },
  });
  service = createService({
    configDir: files.configDir,
    secretsFile: files.secretsFile,
    servingSourceCommit: FIXTURE_SERVING_COMMIT,
  });
  const untrustedService = createService({
    configDir: untrustedFiles.configDir,
    secretsFile: untrustedFiles.secretsFile,
    servingSourceCommit: FIXTURE_SERVING_COMMIT,
  });
  const disabledService = createService({
    configDir: null,
    secretsFile: files.secretsFile,
    servingSourceCommit: FIXTURE_SERVING_COMMIT,
  });
  const unavailableService = createService({
    configDir: `${files.directory}/missing-config`,
    secretsFile: files.secretsFile,
    servingSourceCommit: FIXTURE_SERVING_COMMIT,
  });

  bootstrapApp = await buildBootstrapApp(service);
  companyBlockApp = await buildBootstrapApp(service);
  untrustedApp = await buildBootstrapApp(untrustedService);
  disabledApp = await buildBootstrapApp(disabledService);
  unavailableApp = await buildBootstrapApp(unavailableService);
  runtimePortableApp = await buildRuntimeApp(service);
  runtimePlainApp = await buildRuntimeApp(undefined);
  runtimeDisabledApp = await buildRuntimeApp(disabledService);
});

afterAll(async () => {
  await Promise.all([
    bootstrapApp.close(),
    companyBlockApp.close(),
    untrustedApp.close(),
    disabledApp.close(),
    unavailableApp.close(),
    runtimePortableApp.close(),
    runtimePlainApp.close(),
    runtimeDisabledApp.close(),
  ]);
  await Promise.all([files.cleanup(), untrustedFiles.cleanup()]);
});

describe("node bootstrap route", () => {
  it("requires a node credential and rejects a common service token with 403", async () => {
    const response = await bootstrap(bootstrapApp, COMMON_TOKEN);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ code: "NODE_CREDENTIAL_REQUIRED" });
  });

  it("rejects a revoked or unknown credential with 401", async () => {
    const response = await bootstrap(bootstrapApp, "revoked-token");
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "NODE_BOOTSTRAP_UNAUTHORIZED" });
  });

  it("rejects a serving commit mismatch with 409", async () => {
    const response = await bootstrap(bootstrapApp, "node-token", {
      source_commit: "a".repeat(40),
      platform: "linux",
      arch: "x64",
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ code: "RELEASE_VERSION_MISMATCH" });
  });

  it("rejects an unsupported platform or arch with 400", async () => {
    for (const payload of [
      { source_commit: FIXTURE_SERVING_COMMIT, platform: "freebsd", arch: "x64" },
      { source_commit: FIXTURE_SERVING_COMMIT, platform: "linux", arch: "ia32" },
      { source_commit: FIXTURE_SERVING_COMMIT, platform: "linux" },
    ]) {
      const response = await bootstrap(bootstrapApp, "node-token", payload);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ code: "INVALID_BOOTSTRAP_REQUEST" });
    }
  });

  it("serves the transformed config with no-store caching", async () => {
    const response = await bootstrap(bootstrapApp, "node-token");
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json();
    expect(body.source_commit).toBe(FIXTURE_SERVING_COMMIT);
    expect(body.config_generation).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
    expect(body.agents.agents).toHaveLength(7);
    expect(body.model_catalog.presets).toHaveLength(5);
    expect(body.mcp_registry.servers).toHaveLength(4);
    expect(body.mcp_profiles.profiles).toHaveLength(2);
    expect(body.env.ATOM_API_KEY).toBe("fixture-atom-key-value");
    expect(JSON.stringify(body)).not.toContain(FIXTURE_SOULSTREAM_TOKEN);
  });

  it("applies the China block only to a company principal", async () => {
    const response = await bootstrap(companyBlockApp, "company-token");
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.model_catalog.presets.map((preset: { id: string }) => preset.id))
      .not.toContain("preset-china");
    expect(body.env.OPENCODE_GO_API_KEY).toBeUndefined();
    expect(body.env.KIMI_API_KEY).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(FIXTURE_OPENCODE_KEY_VALUE);
    expect(JSON.stringify(body)).not.toContain(FIXTURE_KIMI_KEY_VALUE);
  });

  it("returns 409 TRUST_CLASSIFICATION_PENDING when no preset is trusted", async () => {
    const response = await bootstrap(untrustedApp, "node-token");
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ code: "TRUST_CLASSIFICATION_PENDING" });
  });

  it("returns 503 PORTABLE_CONFIG_DISABLED when the environment is missing", async () => {
    const response = await bootstrap(disabledApp, "node-token");
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ code: "PORTABLE_CONFIG_DISABLED" });
  });

  it("returns 503 PORTABLE_CONFIG_UNAVAILABLE when a source cannot be read", async () => {
    const response = await bootstrap(unavailableApp, "node-token");
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ code: "PORTABLE_CONFIG_UNAVAILABLE" });
  });
});

describe("agent profile runtime transform", () => {
  it("filters node credential requests and nulls presets outside the node set", async () => {
    const response = await runtimePortableApp.inject({
      method: "GET",
      url: "/api/agent-profiles/runtime",
      headers: { authorization: "Bearer node-token" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.profiles.map((profile: { agent_id: string }) => profile.agent_id)).toEqual([
      "agent-a",
      "agent-b",
    ]);
    expect(body.profiles[0].default_preset).toBe("preset-claude-a");
    expect(body.profiles[1].default_preset).toBeNull();
  });

  it("leaves a common-token runtime response unchanged", async () => {
    const portableResponse = await runtimePortableApp.inject({
      method: "GET",
      url: "/api/agent-profiles/runtime",
      headers: { authorization: `Bearer ${COMMON_TOKEN}` },
    });
    const plainResponse = await runtimePlainApp.inject({
      method: "GET",
      url: "/api/agent-profiles/runtime",
    });
    expect(portableResponse.statusCode).toBe(200);
    expect(portableResponse.body).toBe(plainResponse.body);
    const body = portableResponse.json();
    expect(body.profiles.map((profile: { agent_id: string }) => profile.agent_id)).toEqual([
      "agent-a",
      "agent-b",
      "agent-h",
    ]);
    expect(body.profiles[1].default_preset).toBe("preset-untrusted-a");
  });

  it("fails closed for node credentials when the transformation is disabled", async () => {
    const response = await runtimeDisabledApp.inject({
      method: "GET",
      url: "/api/agent-profiles/runtime",
      headers: { authorization: "Bearer node-token" },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ code: "PORTABLE_CONFIG_DISABLED" });
  });
});

function createService(options: PortableConfigServiceOptions): PortableConfigService {
  return new PortableConfigService(options);
}

async function buildBootstrapApp(portableConfig: PortableConfigService): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerNodeBootstrapRoutes(app, {
    service: portableConfig,
    authBearerToken: COMMON_TOKEN,
    environment: "test",
    nodeCredentials,
  });
  await app.ready();
  return app;
}

async function buildRuntimeApp(
  portableConfig: PortableConfigService | undefined,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const repository = {
    list: async () => runtimeProfiles,
  } as unknown as AgentProfileRepository;
  registerAgentProfileRoutes(app, {
    repository,
    bundleRepository: { list: async () => [] } as never,
    ...(portableConfig === undefined
      ? {}
      : {
          portableRuntimeProfileTransform: {
            authBearerToken: COMMON_TOKEN,
            environment: "test",
            nodeCredentials,
            transform: (companyPc: boolean) => portableConfig.transform(companyPc),
          },
        }),
  });
  await app.ready();
  return app;
}

function bootstrap(
  app: FastifyInstance,
  token: string,
  payload: Record<string, unknown> = {
    source_commit: FIXTURE_SERVING_COMMIT,
    platform: "linux",
    arch: "x64",
  },
) {
  return app.inject({
    method: "POST",
    url: "/api/node/bootstrap",
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}

function runtimeProfile(agentId: string, defaultPreset: string | null): AgentProfileRecord {
  return {
    agentId,
    name: `Agent ${agentId}`,
    contextBundles: [],
    atomContexts: [],
    defaultPreset,
    aliases: [],
    hasPortrait: false,
    portrait: null,
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
