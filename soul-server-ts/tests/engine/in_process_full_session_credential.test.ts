/**
 * in-process 엔진 경로(SOUL_RUNNER_PROCESS_ENABLED=false)의 full 세션 자격.
 *
 * 러너 경로와 같은 변환 함수를 써서 엔진에 넘기는 env와 soulstream 내부 대상
 * MCP 헤더를 그 세션의 ssf1로 바꾸고, 호스트 서비스 토큰 값을 남기지 않는다.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseModelCatalogYaml } from "@soulstream/model-catalog";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import { McpConfigService } from "../../src/mcp_config_service.js";
import type { ResolvedMcpServer } from "../../src/mcp_config_service.js";
import { createEngineFactory } from "../../src/runtime/engine_factory.js";
import {
  FULL_SESSION_MCP_TOKEN_PREFIX,
  verifyFullSessionMcpToken,
} from "../../src/security/restricted_mcp_auth.js";

import { makeTempDirSync } from "../helpers/temp_dir.js";

const { mockCodexCtor } = vi.hoisted(() => ({ mockCodexCtor: vi.fn() }));

vi.mock("@openai/codex-sdk", () => ({
  Codex: class MockCodex {
    constructor(options: unknown) {
      mockCodexCtor(options);
    }
    startThread(): never {
      throw new Error("not used");
    }
    resumeThread(): never {
      throw new Error("not used");
    }
  },
}));

const logger = pino({ level: "silent" });
const MODEL_CATALOG = parseModelCatalogYaml(readFileSync(
  fileURLToPath(new URL("../../../packages/model-catalog/data/model-catalog.yaml", import.meta.url)),
  "utf-8",
));
const getModelCatalog = () => MODEL_CATALOG;
const factoryEnv = {
  CODEX_ADAPTER_MODE: "sdk" as const,
  CODEX_APP_SERVER_REQUEST_TIMEOUT_MS: 30_000,
  CODEX_APP_SERVER_STARTUP_TIMEOUT_MS: 120_000,
  CODEX_DETACHED_RESULT_RETENTION_MS: 1_800_000,
  CLAUDE_SESSION_RUNTIME_V2_ENABLED: false,
  CLAUDE_ACCOUNT_POOL_ENABLED: false,
  CLAUDE_SESSION_RUNTIME_IDLE_TTL_MS: 60_000,
  CLAUDE_SESSION_RUNTIME_MAX_ENTRIES: 1,
  MCP_INTERNAL_PORT: 4206,
  MCP_PATH: "/mcp",
  SOUL_RUNNER_STATE_DIR: "/tmp/soulstream-in-process-credential-state",
};
const HOST_TOKEN = "host-service-token-0001";
const SESSION = "11111111-1111-4111-8111-111111111111";

function writeMcpProfile(directory: string): void {
  writeFileSync(
    join(directory, "mcp-registry.yaml"),
    JSON.stringify({
      servers: [
        {
          id: "soulstream",
          type: "streamable_http",
          name: "soulstream",
          url: "http://127.0.0.1:3105/mcp",
          headers: { Authorization: { env: "AUTH_BEARER_TOKEN" } },
        },
        {
          id: "external",
          type: "streamable_http",
          name: "external",
          url: "https://mcp.example.test/tools",
          headers: { Authorization: "fixture-secret" },
        },
      ],
    }),
  );
  writeFileSync(
    join(directory, "mcp-profiles.yaml"),
    JSON.stringify({
      profiles: [{ id: "full", mcp_servers: ["soulstream", "external"] }],
    }),
  );
}

describe("in-process full session credential", () => {
  it("replaces engine env and soulstream MCP authorization with the session token", () => {
    const workspaceDir = makeTempDirSync("in-process-credential-");
    writeMcpProfile(workspaceDir);
    const factory = createEngineFactory({
      env: factoryEnv,
      logger,
      getModelCatalog,
      codexProcessEnv: { AUTH_BEARER_TOKEN: HOST_TOKEN },
      antigravityProcessEnv: { AUTH_BEARER_TOKEN: HOST_TOKEN },
      buildClaudeProcessEnv: () => ({
        PATH: "/usr/bin",
        AUTH_BEARER_TOKEN: HOST_TOKEN,
        PORTABLE_LOCAL_MCP_AUTHORIZATION: HOST_TOKEN,
      }),
      hostAuthBearerToken: HOST_TOKEN,
      mcpConfigService: new McpConfigService({
        agentsConfigPath: join(workspaceDir, "agents.yaml"),
        processEnv: { AUTH_BEARER_TOKEN: HOST_TOKEN },
      }),
    });
    const profile: AgentProfile = {
      id: "in-process-agent",
      name: "In Process Agent",
      backend: "claude",
      model: "claude-sonnet-4.5",
      workspace_dir: workspaceDir,
      mcp_profile: "full",
    };

    const engine = factory(profile, undefined, SESSION) as unknown as {
      processEnv?: NodeJS.ProcessEnv;
      resolvedMcpServers?: ResolvedMcpServer[];
    };
    const credential = engine.processEnv?.AUTH_BEARER_TOKEN;

    expect(credential?.startsWith(FULL_SESSION_MCP_TOKEN_PREFIX)).toBe(true);
    expect(verifyFullSessionMcpToken(credential!, HOST_TOKEN)).toEqual({
      ok: true,
      sessionId: SESSION,
    });
    expect(engine.processEnv?.PORTABLE_LOCAL_MCP_AUTHORIZATION).toBe(credential);
    expect(engine.processEnv?.PATH).toBe("/usr/bin");
    expect(JSON.stringify(engine.processEnv)).not.toContain(HOST_TOKEN);

    const servers = engine.resolvedMcpServers!;
    const soulstream = servers.find((server) => server.name === "soulstream")!;
    expect(soulstream.type).toBe("streamable_http");
    if (soulstream.type !== "streamable_http") return;
    expect(soulstream.headers).toEqual({ Authorization: `Bearer ${credential}` });
    expect(servers.find((server) => server.name === "external")).toEqual({
      type: "streamable_http",
      name: "external",
      url: "https://mcp.example.test/tools",
      headers: { Authorization: "fixture-secret" },
    });
  });

  it("leaves the engine env alone when no session id is given", () => {
    const workspaceDir = makeTempDirSync("in-process-credential-none-");
    writeMcpProfile(workspaceDir);
    const factory = createEngineFactory({
      env: factoryEnv,
      logger,
      getModelCatalog,
      codexProcessEnv: {},
      antigravityProcessEnv: {},
      buildClaudeProcessEnv: () => ({ AUTH_BEARER_TOKEN: HOST_TOKEN }),
      hostAuthBearerToken: HOST_TOKEN,
      mcpConfigService: new McpConfigService({
        agentsConfigPath: join(workspaceDir, "agents.yaml"),
        processEnv: { AUTH_BEARER_TOKEN: HOST_TOKEN },
      }),
    });
    const profile: AgentProfile = {
      id: "in-process-agent",
      name: "In Process Agent",
      backend: "claude",
      model: "claude-sonnet-4.5",
      workspace_dir: workspaceDir,
    };

    const engine = factory(profile) as unknown as {
      processEnv?: NodeJS.ProcessEnv;
    };
    expect(engine.processEnv?.AUTH_BEARER_TOKEN).toBe(HOST_TOKEN);
  });

  it("gives the codex SDK engine child the session token instead of the host token", () => {
    const workspaceDir = makeTempDirSync("in-process-credential-codex-");
    const factory = createEngineFactory({
      env: factoryEnv,
      logger,
      getModelCatalog,
      codexProcessEnv: {
        AUTH_BEARER_TOKEN: HOST_TOKEN,
        CODEX_HOME: "/tmp/codex-home",
      },
      antigravityProcessEnv: {},
      buildClaudeProcessEnv: () => ({}),
      hostAuthBearerToken: HOST_TOKEN,
      mcpConfigService: new McpConfigService({
        agentsConfigPath: join(workspaceDir, "agents.yaml"),
        processEnv: { AUTH_BEARER_TOKEN: HOST_TOKEN },
      }),
    });
    const profile: AgentProfile = {
      id: "in-process-codex-agent",
      name: "In Process Codex Agent",
      backend: "codex",
      model: "gpt-5.1-codex",
      workspace_dir: workspaceDir,
    };

    factory(profile, undefined, SESSION);

    expect(mockCodexCtor).toHaveBeenCalledTimes(1);
    const options = mockCodexCtor.mock.calls[0]![0] as {
      env: Record<string, string>;
    };
    const credential = options.env.AUTH_BEARER_TOKEN!;
    expect(credential.startsWith(FULL_SESSION_MCP_TOKEN_PREFIX)).toBe(true);
    expect(verifyFullSessionMcpToken(credential, HOST_TOKEN)).toEqual({
      ok: true,
      sessionId: SESSION,
    });
    expect(options.env.CODEX_HOME).toBe("/tmp/codex-home");
    expect(JSON.stringify(options.env)).not.toContain(HOST_TOKEN);
  });
});
