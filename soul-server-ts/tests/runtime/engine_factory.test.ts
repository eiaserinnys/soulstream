import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SessionStore } from "@anthropic-ai/claude-agent-sdk";
import pino from "pino";
import { describe, expect, it } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import { McpConfigService } from "../../src/mcp_config_service.js";
import { createEngineFactory } from "../../src/runtime/engine_factory.js";

import { makeTempDirSync } from "../helpers/temp_dir.js";

const logger = pino({ level: "silent" });
const sessionStore: SessionStore = {
  async append() {},
  async load() {
    return null;
  },
};
const factoryEnv = {
  CODEX_ADAPTER_MODE: "sdk" as const,
  CODEX_APP_SERVER_REQUEST_TIMEOUT_MS: 30_000,
  CODEX_APP_SERVER_STARTUP_TIMEOUT_MS: 120_000,
  CODEX_DETACHED_RESULT_RETENTION_MS: 1_800_000,
  CLAUDE_SESSION_RUNTIME_V2_ENABLED: false,
  MCP_INTERNAL_PORT: 4206,
  MCP_PATH: "/mcp",
  SOUL_RUNNER_STATE_DIR: "/tmp/soulstream-factory-state",
};

describe("createEngineFactory", () => {
  it("creates different agent engines in one shared workspace without an ownership marker", () => {
    const workspaceDir = makeTempDirSync("shared-agent-workspace-");
    const factory = createEngineFactory({
      env: factoryEnv,
      logger,
      codexProcessEnv: {},
      antigravityProcessEnv: {},
      buildClaudeProcessEnv: () => ({}),
      claudeSessionStore: sessionStore,
      mcpConfigService: new McpConfigService({
        agentsConfigPath: join(workspaceDir, "agents.yaml"),
      }),
    });
    const profiles: AgentProfile[] = [
      {
        id: "roselin_codex",
        name: "로젤린 (Codex)",
        backend: "codex",
        model: "gpt-5.6-sol",
        workspace_dir: workspaceDir,
      },
      {
        id: "roselin_kimi",
        name: "로젤린 (Kimi)",
        backend: "claude",
        model: "kimi-for-coding",
        workspace_dir: workspaceDir,
      },
    ];

    try {
      const engines = profiles.map((profile) => factory(profile));

      expect(engines.map((engine) => engine.backendId)).toEqual(["codex", "claude"]);
      expect(engines.every((engine) => engine.workspaceDir === workspaceDir)).toBe(true);
      expect(existsSync(join(workspaceDir, ".local", ".agent_marker"))).toBe(false);
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("uses a preset backend override without mutating the agent profile", () => {
    const workspaceDir = makeTempDirSync("preset-backend-workspace-");
    const factory = createEngineFactory({
      env: factoryEnv,
      logger,
      codexProcessEnv: {},
      antigravityProcessEnv: {},
      buildClaudeProcessEnv: () => ({}),
      claudeSessionStore: sessionStore,
      mcpConfigService: new McpConfigService({
        agentsConfigPath: join(workspaceDir, "agents.yaml"),
      }),
    });
    const profile: AgentProfile = {
      id: "roselin",
      name: "로젤린",
      backend: "codex",
      workspace_dir: workspaceDir,
    };

    try {
      const engine = factory(profile, "claude");

      expect(engine.backendId).toBe("claude");
      expect(profile.backend).toBe("codex");
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("injects the host Claude account service into the in-process engine", () => {
    const workspaceDir = makeTempDirSync("claude-account-pool-engine-");
    const claudeAccountTurnPort = {
      select: () => Promise.resolve(null),
      reject: () => Promise.resolve(),
      release: () => Promise.resolve(),
    };
    const factory = createEngineFactory({
      env: { ...factoryEnv, CLAUDE_ACCOUNT_POOL_ENABLED: true },
      logger,
      codexProcessEnv: {},
      antigravityProcessEnv: {},
      buildClaudeProcessEnv: () => ({}),
      claudeSessionStore: sessionStore,
      claudeAccountTurnPort,
      mcpConfigService: new McpConfigService({
        agentsConfigPath: join(workspaceDir, "agents.yaml"),
      }),
    });
    const engine = factory({
      id: "pool-agent",
      name: "Pool Agent",
      backend: "claude",
      model: "claude-sonnet-4.5",
      workspace_dir: workspaceDir,
    } as AgentProfile) as unknown as {
      claudeAccountTurnPort: unknown;
      trackChildExit: boolean;
    };

    expect(engine.claudeAccountTurnPort).toBe(claudeAccountTurnPort);
    expect(engine.trackChildExit).toBe(true);
  });

  it("fails explicitly when a Codex MCP profile is used with the legacy SDK adapter", () => {
    const workspaceDir = makeTempDirSync("codex-mcp-profile-");
    writeFileSync(
      join(workspaceDir, "mcp-profiles.yaml"),
      ["profiles:", "  - id: full", ""].join("\n"),
      "utf-8",
    );
    const factory = createEngineFactory({
      env: factoryEnv,
      logger,
      codexProcessEnv: {},
      antigravityProcessEnv: {},
      buildClaudeProcessEnv: () => ({}),
      claudeSessionStore: sessionStore,
      mcpConfigService: new McpConfigService({
        agentsConfigPath: join(workspaceDir, "agents.yaml"),
      }),
    });
    const profile: AgentProfile = {
      id: "roselin_codex",
      name: "로젤린 (Codex)",
      backend: "codex",
      model: "gpt-5.6-sol",
      workspace_dir: workspaceDir,
      mcp_profile: "full",
    };

    try {
      expect(() => factory(profile)).toThrow(
        /mcp_profile requires CODEX_ADAPTER_MODE=app-server/,
      );
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});
