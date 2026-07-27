import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SessionStore } from "@anthropic-ai/claude-agent-sdk";
import pino from "pino";
import { describe, expect, it } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import { createEngineFactory } from "../../src/runtime/engine_factory.js";

const logger = pino({ level: "silent" });
const sessionStore: SessionStore = {
  async append() {},
  async load() {
    return null;
  },
};

describe("createEngineFactory", () => {
  it("creates different agent engines in one shared workspace without an ownership marker", () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "shared-agent-workspace-"));
    const factory = createEngineFactory({
      env: {
        CODEX_ADAPTER_MODE: "sdk",
        CLAUDE_SESSION_RUNTIME_V2_ENABLED: false,
      },
      logger,
      codexProcessEnv: {},
      buildClaudeProcessEnv: () => ({}),
      claudeSessionStore: sessionStore,
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
});
