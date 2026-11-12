/**
 * 무설치 노드 실행기의 기본 설정(portable-node/config)을 soul-server가 실제로 읽는지 확인한다.
 * 실행기는 두 자리표시자를 이번 실행 값으로 바꿔 쓰고, soul-server는 그 파일을 자기 schema로 읽는다.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { readAgentsConfig } from "../src/agent_registry.js";
import { McpConfigService } from "../src/mcp_config_service.js";

import { makeTempDirSync } from "./helpers/temp_dir.js";

const TEMPLATES_DIR = fileURLToPath(new URL("../../portable-node/config/", import.meta.url));
const FILES = ["agents.yaml", "mcp-registry.yaml", "mcp-profiles.yaml"];

function renderTemplates(stateRoot: string, hostPort: number): string {
  const directory = makeTempDirSync("portable-node-config-");
  for (const file of FILES) {
    const rendered = fs
      .readFileSync(path.join(TEMPLATES_DIR, file), "utf8")
      .split("__STATE_ROOT__").join(stateRoot)
      .split("__SOUL_HOST_PORT__").join(String(hostPort));
    fs.writeFileSync(path.join(directory, file), rendered);
  }
  return directory;
}

describe("portable node default config", () => {
  it("renders two default agents with their presets and one local soulstream MCP server", () => {
    const stateRoot = makeTempDirSync("portable-node-state-");
    const hostPort = 43117;
    const configDir = renderTemplates(stateRoot, hostPort);
    const agentsConfigPath = path.join(configDir, "agents.yaml");

    const config = readAgentsConfig(agentsConfigPath);
    expect(config.agents.map((agent) => agent.id)).toEqual(["claude-default", "codex-default"]);
    expect(config.agents.map((agent) => agent.name)).toEqual(["Claude", "Codex"]);
    expect(config.agents.map((agent) => agent.backend)).toEqual(["claude", "codex"]);
    expect(config.agents.map((agent) => agent.default_preset)).toEqual([
      "claude-opus",
      "codex-6.1-sol",
    ]);
    for (const agent of config.agents) {
      expect(agent.workspace_dir).toBe(path.join(stateRoot, "workspace"));
      expect(agent.mcp_profile).toBe("portable-default");
    }

    expect(
      fs.existsSync(path.join(configDir, "model-catalog.yaml")),
      "모델 카탈로그는 portable 템플릿이 아니라 리포 정본 파일입니다.",
    ).toBe(false);

    const service = new McpConfigService({
      agentsConfigPath,
      processEnv: { PORTABLE_LOCAL_MCP_AUTHORIZATION: "Bearer node-token" },
    });
    for (const agent of config.agents) {
      const resolved = service.resolveMcpProfile(agent);
      expect(resolved?.mcp_servers).toHaveLength(1);
      expect(resolved?.mcp_servers[0]).toMatchObject({
        name: "soulstream",
        type: "streamable_http",
        url: `http://127.0.0.1:${hostPort}/mcp`,
        headers: { Authorization: "Bearer node-token" },
      });
    }
  });
});
