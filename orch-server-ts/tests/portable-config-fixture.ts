import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const FIXTURE_SERVING_COMMIT = "f".repeat(40);
export const FIXTURE_SOURCE_WORKSPACE_DIR = "/home/fixture/workspace";
export const FIXTURE_SOULSTREAM_TOKEN = "fixture-common-service-token";
export const FIXTURE_ATOM_KEY_VALUE = "fixture-atom-key-value";
export const FIXTURE_OPENCODE_KEY_VALUE = "fixture-opencode-key-value";
export const FIXTURE_KIMI_KEY_VALUE = "fixture-kimi-key-value";
export const FIXTURE_DATABASE_URL_VALUE = "postgres://fixture-db-secret-value";
export const FIXTURE_GH_TOKEN_VALUE = "fixture-gh-token-value";
export const FIXTURE_GITHUB_TOKEN_VALUE = "fixture-github-token-value";
export const FIXTURE_JWT_SECRET_VALUE = "fixture-jwt-secret-value";
export const FIXTURE_AUTH_BEARER_VALUE = "fixture-auth-bearer-value";
export const FIXTURE_GOOGLE_SECRET_VALUE = "fixture-google-secret-value";
export const FIXTURE_ANTHROPIC_VALUE = "fixture-anthropic-value";

export const FIXTURE_SHARED_AGENT_IDS = [
  "agent-a",
  "agent-b",
  "agent-c",
  "agent-d",
  "agent-e",
  "agent-f",
  "agent-g",
] as const;

export const FIXTURE_FORBIDDEN_ENV_VALUES = [
  FIXTURE_DATABASE_URL_VALUE,
  FIXTURE_GH_TOKEN_VALUE,
  FIXTURE_GITHUB_TOKEN_VALUE,
  FIXTURE_JWT_SECRET_VALUE,
  FIXTURE_AUTH_BEARER_VALUE,
  FIXTURE_GOOGLE_SECRET_VALUE,
  FIXTURE_ANTHROPIC_VALUE,
] as const;

export const ALLOW_LIST = [
  "ATOM_API_KEY",
  "EXA_API_KEY",
  "OPENCODE_GO_API_KEY",
  "KIMI_API_KEY",
  "DATABASE_URL",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "JWT_SECRET",
  "AUTH_BEARER_TOKEN",
  "GOOGLE_CLIENT_SECRET",
  "ANTHROPIC_API_KEY",
  "mcp:soulstream",
  "mcp:soulstream-cogito",
  "mcp:atom-remote",
  "mcp:remote-east",
  "mcp:forbidden-header",
] as const;

export const FIXTURE_POLICY = {
  source_workspace_dir: FIXTURE_SOURCE_WORKSPACE_DIR,
  public_env: { ATOM_SERVER_URL: "https://atom.example.test" },
  mcp_public_urls: { "atom-remote": "https://atom.example.test/mcp" },
  personal_allow: [...ALLOW_LIST],
  company_allow: [...ALLOW_LIST],
} as const;

export const FIXTURE_SOURCE_ENV: Record<string, string> = {
  ATOM_API_KEY: FIXTURE_ATOM_KEY_VALUE,
  EXA_API_KEY: "fixture-exa-key-value",
  OPENCODE_GO_API_KEY: FIXTURE_OPENCODE_KEY_VALUE,
  KIMI_API_KEY: FIXTURE_KIMI_KEY_VALUE,
  DATABASE_URL: FIXTURE_DATABASE_URL_VALUE,
  GH_TOKEN: FIXTURE_GH_TOKEN_VALUE,
  GITHUB_TOKEN: FIXTURE_GITHUB_TOKEN_VALUE,
  JWT_SECRET: FIXTURE_JWT_SECRET_VALUE,
  AUTH_BEARER_TOKEN: FIXTURE_AUTH_BEARER_VALUE,
  GOOGLE_CLIENT_SECRET: FIXTURE_GOOGLE_SECRET_VALUE,
  ANTHROPIC_API_KEY: FIXTURE_ANTHROPIC_VALUE,
  UNRELATED_KEY: "fixture-unrelated-value",
};

function agent(
  id: string,
  backend: "claude" | "codex",
  defaultPreset: string | undefined,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    name: `Agent ${id}`,
    backend,
    workspace_dir: FIXTURE_SOURCE_WORKSPACE_DIR,
    ...(defaultPreset === undefined ? {} : { default_preset: defaultPreset }),
    ...overrides,
  };
}

export function createPortableFixture(): {
  agentsConfig: unknown;
  modelCatalog: unknown;
  mcpRegistry: unknown;
  mcpProfiles: unknown;
} {
  return {
    agentsConfig: {
      agents: [
        agent("agent-a", "claude", "preset-claude-a", {
          aliases: ["alias-a"],
          portrait_path: "/home/fixture/portraits/agent-a.png",
          allowed_tools: ["Bash"],
          atom_contexts: [
            { node_id: "00000000-0000-4000-8000-000000000000", depth: 2 },
          ],
          mcp_profile: "profile-main",
        }),
        agent("agent-b", "claude", "preset-claude-a", { mcp_profile: "profile-empty" }),
        agent("agent-c", "claude", "preset-claude-b"),
        agent("agent-d", "codex", "preset-codex-a", { mcp_profile: "profile-main" }),
        agent("agent-e", "codex", "preset-codex-a"),
        agent("agent-f", "codex", "preset-codex-b"),
        agent("agent-g", "claude", "preset-claude-b"),
        agent("agent-h", "claude", "preset-claude-a", {
          workspace_dir: "/home/fixture/agents/agent-h",
          mcp_profile: "profile-orphan",
        }),
        agent("agent-i", "codex", "preset-codex-a", {
          workspace_dir: "/home/fixture/agents/agent-i",
        }),
        agent("agent-j", "claude", "preset-claude-b", {
          workspace_dir: "/home/fixture/agents/agent-j",
        }),
        agent("agent-k", "claude", undefined),
        agent("agent-l", "claude", "preset-untrusted-a"),
        agent("agent-m", "codex", "preset-untrusted-b"),
      ],
    },
    modelCatalog: {
      presets: [
        {
          id: "preset-claude-a",
          label: "Claude A",
          backend: "claude",
          model: "claude-a",
          env: { ANTHROPIC_BASE_URL: "https://claude.example.test" },
          trusted_execution: true,
        },
        {
          id: "preset-claude-b",
          label: "Claude B",
          backend: "claude",
          model: "claude-b",
          env: { CACHE_URL: "${DATABASE_URL}" },
          trusted_execution: true,
        },
        {
          id: "preset-codex-a",
          label: "Codex A",
          backend: "codex",
          model: "gpt-a",
          trusted_execution: true,
        },
        {
          id: "preset-codex-b",
          label: "Codex B",
          backend: "codex",
          model: "gpt-b",
          trusted_execution: true,
        },
        {
          id: "preset-antigravity",
          label: "Antigravity A",
          backend: "antigravity",
          model: "gemini-a",
          trusted_execution: true,
        },
        {
          id: "preset-china",
          label: "China A",
          backend: "claude",
          model: "deepseek-v4.1",
          env: {
            OPENCODE_GO_API_KEY: "${OPENCODE_GO_API_KEY}",
            KIMI_API_KEY: "${KIMI_API_KEY}",
          },
          trusted_execution: true,
        },
        {
          id: "preset-untrusted-a",
          label: "Untrusted A",
          backend: "claude",
          model: "claude-u",
        },
        {
          id: "preset-untrusted-b",
          label: "Untrusted B",
          backend: "codex",
          model: "gpt-u",
          trusted_execution: false,
        },
      ],
    },
    mcpRegistry: {
      servers: [
        {
          id: "soulstream",
          type: "streamable_http",
          url: "http://127.0.0.1:5200/mcp",
          headers: {
            Authorization: `Bearer ${FIXTURE_SOULSTREAM_TOKEN}`,
            "X-Trace": "fixture",
          },
        },
        {
          id: "soulstream-cogito",
          type: "streamable_http",
          url: "http://127.0.0.1:5200/cogito/mcp",
          headers: { Authorization: `Bearer ${FIXTURE_SOULSTREAM_TOKEN}` },
        },
        {
          id: "atom-remote",
          type: "streamable_http",
          url: "http://localhost:4200/mcp",
          headers: { "X-Api-Key": { env: "ATOM_API_KEY" } },
        },
        {
          id: "remote-east",
          type: "streamable_http",
          url: "https://mcp.example.test/mcp",
          headers: { Authorization: { env: "EXA_API_KEY" } },
        },
        {
          id: "stdio-tool",
          type: "stdio",
          command: "node",
          args: ["tool.mjs"],
        },
        {
          id: "blocked-server",
          type: "streamable_http",
          url: "https://blocked.example.test/mcp",
        },
        {
          id: "unmapped-local",
          type: "sse",
          url: "http://127.0.0.1:9999/sse",
        },
        {
          id: "forbidden-header",
          type: "streamable_http",
          url: "https://forbidden.example.test/mcp",
          headers: { Authorization: { env: "GHOST_KEY" } },
        },
      ],
    },
    mcpProfiles: {
      profiles: [
        {
          id: "profile-main",
          mcp_servers: [
            "soulstream",
            "soulstream-cogito",
            "atom-remote",
            "remote-east",
            "stdio-tool",
            "blocked-server",
            "unmapped-local",
            "forbidden-header",
          ],
          hosted_tools: [],
        },
        {
          id: "profile-empty",
          mcp_servers: ["stdio-tool"],
          hosted_tools: [],
        },
        {
          id: "profile-orphan",
          mcp_servers: ["remote-east"],
          hosted_tools: [],
        },
      ],
    },
  };
}

export type PortableFixtureFiles = {
  readonly directory: string;
  readonly configDir: string;
  readonly secretsFile: string;
  cleanup(): Promise<void>;
};

export async function writePortableFixtureFiles(
  overrides: { modelCatalog?: unknown; agentsConfig?: unknown } = {},
): Promise<PortableFixtureFiles> {
  const directory = await mkdtemp(path.join(tmpdir(), "portable-config-"));
  const configDir = path.join(directory, "config");
  const sourceEnvFile = path.join(directory, "source.env");
  const secretsFile = path.join(directory, "policy.json");
  const fixture = createPortableFixture();
  const modelCatalog = overrides.modelCatalog ?? fixture.modelCatalog;
  const agentsConfig = overrides.agentsConfig ?? fixture.agentsConfig;
  await mkdir(configDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(configDir, "agents.yaml"), JSON.stringify(agentsConfig), "utf-8"),
    writeFile(
      path.join(configDir, "model-catalog.yaml"),
      JSON.stringify(modelCatalog),
      "utf-8",
    ),
    writeFile(
      path.join(configDir, "mcp-registry.yaml"),
      JSON.stringify(fixture.mcpRegistry),
      "utf-8",
    ),
    writeFile(
      path.join(configDir, "mcp-profiles.yaml"),
      JSON.stringify(fixture.mcpProfiles),
      "utf-8",
    ),
    writeFile(
      secretsFile,
      JSON.stringify({ ...FIXTURE_POLICY, source_env_file: sourceEnvFile }),
      "utf-8",
    ),
    writeFile(
      sourceEnvFile,
      Object.entries(FIXTURE_SOURCE_ENV)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n"),
      "utf-8",
    ),
  ]);
  return {
    directory,
    configDir,
    secretsFile,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}
