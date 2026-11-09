import { describe, expect, it } from "vitest";

import {
  PortableConfigTransformError,
  transformPortableConfig,
  type PortableConfigTransformInput,
} from "../src/node_bootstrap/portable_config_transform.js";
import {
  FIXTURE_ATOM_KEY_VALUE,
  FIXTURE_FORBIDDEN_ENV_VALUES,
  FIXTURE_KIMI_KEY_VALUE,
  FIXTURE_OPENCODE_KEY_VALUE,
  FIXTURE_POLICY,
  FIXTURE_SERVING_COMMIT,
  FIXTURE_SHARED_AGENT_IDS,
  FIXTURE_SOULSTREAM_TOKEN,
  FIXTURE_SOURCE_ENV,
  createPortableFixture,
} from "./portable-config-fixture.js";

const fixture = createPortableFixture();

function transform(
  overrides: Partial<PortableConfigTransformInput> = {},
): ReturnType<typeof transformPortableConfig> {
  return transformPortableConfig({
    agentsConfig: fixture.agentsConfig,
    modelCatalog: fixture.modelCatalog,
    mcpRegistry: fixture.mcpRegistry,
    mcpProfiles: fixture.mcpProfiles,
    policy: FIXTURE_POLICY,
    sourceEnv: FIXTURE_SOURCE_ENV,
    companyPc: false,
    sourceCommit: FIXTURE_SERVING_COMMIT,
    ...overrides,
  });
}

describe("portable config transform", () => {
  it("rejects the node when no preset carries a trusted execution marker", () => {
    const catalog = fixture.modelCatalog as { presets: Array<Record<string, unknown>> };
    const modelCatalog = {
      presets: catalog.presets.map((preset) => {
        const { trusted_execution: _trusted, ...rest } = preset;
        return rest;
      }),
    };
    try {
      transform({ modelCatalog });
      expect.unreachable("transform should reject an untrusted catalog");
    } catch (error) {
      expect(error).toBeInstanceOf(PortableConfigTransformError);
      expect((error as PortableConfigTransformError).code).toBe("TRUST_CLASSIFICATION_PENDING");
    }
  });

  it("keeps five trusted presets and the seven shared-work-folder agents", () => {
    const { response, remainingAgentIds, remainingPresetIds } = transform();

    expect(response.model_catalog.presets.map((preset) => preset.id)).toEqual([
      "preset-claude-a",
      "preset-claude-b",
      "preset-codex-a",
      "preset-codex-b",
      "preset-china",
    ]);
    expect(response.excluded.presets).toEqual(expect.arrayContaining([
      { id: "preset-antigravity", reason: "backend_unavailable" },
      { id: "preset-untrusted-a", reason: "not_trusted" },
      { id: "preset-untrusted-b", reason: "not_trusted" },
    ]));
    expect(response.agents.agents.map((agent) => agent.id)).toEqual([
      ...FIXTURE_SHARED_AGENT_IDS,
    ]);
    expect(remainingAgentIds.size).toBe(7);
    expect(remainingPresetIds.size).toBe(5);
    expect(response.excluded.agents).toEqual(expect.arrayContaining([
      { id: "agent-h", reason: "host_specific_workspace" },
      { id: "agent-i", reason: "host_specific_workspace" },
      { id: "agent-j", reason: "host_specific_workspace" },
      { id: "agent-k", reason: "no_default_preset" },
      { id: "agent-l", reason: "not_trusted" },
      { id: "agent-m", reason: "not_trusted" },
    ]));
  });

  it("rewrites the workspace, removes the portrait path, and keeps other agent fields", () => {
    const agentA = transform().response.agents.agents.find(
      (agent) => agent.id === "agent-a",
    );
    expect(agentA).toBeDefined();
    expect(agentA?.workspace_dir).toBe("__STATE_ROOT__/workspace");
    expect(agentA !== undefined && "portrait_path" in agentA).toBe(false);
    expect(agentA?.name).toBe("Agent agent-a");
    expect(agentA?.aliases).toEqual(["alias-a"]);
    expect(agentA?.allowed_tools).toEqual(["Bash"]);
    expect(agentA?.atom_contexts).toEqual([
      { node_id: "00000000-0000-4000-8000-000000000000", depth: 2 },
    ]);
  });

  it("blocks China model presets and their env keys for company nodes", () => {
    const personal = transform().response;
    expect(personal.env.OPENCODE_GO_API_KEY).toBe(FIXTURE_OPENCODE_KEY_VALUE);
    expect(personal.env.KIMI_API_KEY).toBe(FIXTURE_KIMI_KEY_VALUE);

    const { response } = transform({ companyPc: true });
    expect(response.model_catalog.presets.map((preset) => preset.id))
      .not.toContain("preset-china");
    expect(response.excluded.presets).toContainEqual({
      id: "preset-china",
      reason: "company_blocked",
    });
    expect(response.env.OPENCODE_GO_API_KEY).toBeUndefined();
    expect(response.env.KIMI_API_KEY).toBeUndefined();
    expect(JSON.stringify(response)).not.toContain(FIXTURE_OPENCODE_KEY_VALUE);
    expect(JSON.stringify(response)).not.toContain(FIXTURE_KIMI_KEY_VALUE);
  });

  it("never exposes the soulstream common token and rewrites local MCP wiring", () => {
    const { response } = transform();
    const soulstream = response.mcp_registry.servers.find(
      (server) => server.id === "soulstream",
    );
    expect(soulstream?.url).toBe("http://127.0.0.1:__SOUL_HOST_PORT__/mcp");
    expect(soulstream?.headers).toEqual({
      "X-Trace": "fixture",
      Authorization: { env: "PORTABLE_LOCAL_MCP_AUTHORIZATION" },
    });
    expect(JSON.stringify(response)).not.toContain(FIXTURE_SOULSTREAM_TOKEN);
  });

  it("maps localhost servers through public URLs and drops the rest", () => {
    const { response } = transform();
    expect(response.mcp_registry.servers.map((server) => server.id)).toEqual([
      "soulstream",
      "soulstream-cogito",
      "atom-remote",
      "remote-east",
    ]);
    const atomRemote = response.mcp_registry.servers.find(
      (server) => server.id === "atom-remote",
    );
    expect(atomRemote?.url).toBe("https://atom.example.test/mcp");
    expect(response.excluded.mcp_servers).toEqual(expect.arrayContaining([
      { id: "stdio-tool", reason: "host_local" },
      { id: "blocked-server", reason: "not_allowed" },
      { id: "unmapped-local", reason: "host_local" },
      { id: "forbidden-header", reason: "missing_secret" },
    ]));
  });

  it("keeps only profiles referenced by surviving agents and prunes removed servers", () => {
    const profiles = transform().response.mcp_profiles.profiles;
    expect(profiles.map((profile) => profile.id)).toEqual([
      "profile-main",
      "profile-empty",
    ]);
    expect(profiles[0]?.mcp_servers).toEqual([
      "soulstream",
      "soulstream-cogito",
      "atom-remote",
      "remote-east",
    ]);
    expect(profiles[1]?.mcp_servers).toEqual([]);
  });

  it("filters forbidden and company-blocked keys out of public env", () => {
    const policy = {
      ...FIXTURE_POLICY,
      public_env: {
        ...FIXTURE_POLICY.public_env,
        AUTH_BEARER_TOKEN: "fixture-public-bearer-value",
        KIMI_API_KEY: "fixture-public-kimi-value",
      },
    };

    const personal = transform({ policy }).response;
    expect(personal.env.AUTH_BEARER_TOKEN).toBeUndefined();
    expect(personal.env.KIMI_API_KEY).toBe(FIXTURE_KIMI_KEY_VALUE);

    const company = transform({ policy, companyPc: true }).response;
    expect(company.env.AUTH_BEARER_TOKEN).toBeUndefined();
    expect(company.env.KIMI_API_KEY).toBeUndefined();
  });

  it("exports only referenced allowed env keys and never a forbidden key value", () => {
    const { response } = transform();
    expect(response.env).toEqual({
      ATOM_SERVER_URL: "https://atom.example.test",
      ATOM_API_KEY: FIXTURE_ATOM_KEY_VALUE,
      OPENCODE_GO_API_KEY: FIXTURE_OPENCODE_KEY_VALUE,
      KIMI_API_KEY: FIXTURE_KIMI_KEY_VALUE,
      EXA_API_KEY: "fixture-exa-key-value",
    });
    expect(response.env.DATABASE_URL).toBeUndefined();
    expect(response.env.UNRELATED_KEY).toBeUndefined();
    const serialized = JSON.stringify(response);
    for (const forbiddenValue of FIXTURE_FORBIDDEN_ENV_VALUES) {
      expect(serialized).not.toContain(forbiddenValue);
    }
  });

  it("keeps the generation stable for env value changes and changes it on key names", () => {
    const base = transform().response.config_generation;
    expect(base).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
    expect(transform().response.config_generation).toBe(base);
    expect(
      transform({
        sourceEnv: { ...FIXTURE_SOURCE_ENV, ATOM_API_KEY: "changed-value" },
      }).response.config_generation,
    ).toBe(base);
    expect(
      transform({
        policy: {
          ...FIXTURE_POLICY,
          public_env: { ATOM_SERVER_URL: "https://changed.example.test" },
        },
      }).response.config_generation,
    ).toBe(base);
    expect(
      transform({
        policy: {
          ...FIXTURE_POLICY,
          public_env: { ATOM_ENDPOINT: "https://atom.example.test" },
        },
      }).response.config_generation,
    ).not.toBe(base);
  });
});
