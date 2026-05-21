import pino from "pino";
import { describe, expect, it } from "vitest";

import { AgentProfileSchema, type AgentProfile } from "../../src/agent_registry.js";
import { AgentsEngineAdapter } from "../../src/engine/agents_adapter.js";

const silentLogger = pino({ level: "silent" });

function makeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return AgentProfileSchema.parse({
    id: "agent-openai",
    name: "OpenAI Agent",
    backend: "openai-agents",
    workspace_dir: "/tmp/agents",
    agents_sdk: {
      entry_agent: "triage",
      provider: {
        type: "openai",
        api_key_env: "OPENAI_API_KEY",
        use_responses: true,
      },
      agents: [
        {
          id: "triage",
          name: "Triage",
          instructions: "Route work.",
          hosted_tools: [
            { type: "web_search", search_context_size: "medium" },
            { type: "file_search", vector_store_ids: ["vs_123"] },
            { type: "code_interpreter", include_outputs: true },
            { type: "tool_search" },
            { type: "image_generation", size: "1024x1024" },
            {
              type: "hosted_mcp",
              server_label: "docs",
              server_url: "https://mcp.example.com",
              require_approval: "always",
            },
          ],
          mcp_servers: [
            {
              type: "stdio",
              name: "local-docs",
              command: "node",
              args: ["server.js"],
            },
          ],
        },
      ],
    },
    ...overrides,
  });
}

describe("AgentsEngineAdapter provider/hosted tools config", () => {
  it("OpenAI provider, hosted tools, hosted MCP, per-Agent MCP config로 생성 가능", async () => {
    const adapter = new AgentsEngineAdapter(
      {
        workspaceDir: "/tmp/agents",
        profile: makeProfile(),
        processEnv: { OPENAI_API_KEY: "test-key" },
      },
      silentLogger,
    );

    expect(adapter.backendId).toBe("openai-agents");
    await adapter.close();
  });

  it("provider.api_key_env가 지정됐는데 환경변수가 없으면 명시적으로 실패", () => {
    expect(() =>
      new AgentsEngineAdapter(
        {
          workspaceDir: "/tmp/agents",
          profile: makeProfile(),
          processEnv: {},
        },
        silentLogger,
      ),
    ).toThrow(/agents_sdk\.provider\.api_key_env missing/);
  });
});
