/**
 * 무설치 노드 실행기의 기본 설정(portable-node/config)을 soul-server가 실제로 읽는지 확인한다.
 * 실행기가 자리표시자를 채운 설정을 soul-server가 자기 schema로 읽는다.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { readAgentsConfig } from "../src/agent_registry.js";
import { McpConfigService } from "../src/mcp_config_service.js";
import { parseModelCatalogYaml } from "@soulstream/model-catalog";
import { writeConfigGeneration } from "../../portable-node/lib/config.mjs";

import { makeTempDirSync } from "./helpers/temp_dir.js";

const TEMPLATES_DIR = fileURLToPath(new URL("../../portable-node/config/", import.meta.url));
const CATALOG_PATH = fileURLToPath(new URL("../../packages/model-catalog/data/model-catalog.yaml", import.meta.url));

describe("portable node default config", () => {
  it("renders two default agents with their presets and one local soulstream MCP server", async () => {
    const stateRoot = makeTempDirSync("portable-node-state-");
    const hostPort = 43117;
    const { dir: configDir } = await writeConfigGeneration({
      templatesDir: TEMPLATES_DIR,
      stateRoot,
      configRoot: makeTempDirSync("portable-node-config-"),
      hostPort,
      catalogPath: CATALOG_PATH,
    });
    const defaults = parseModelCatalogYaml(fs.readFileSync(CATALOG_PATH, "utf8")).install_defaults!.backends;
    const agentsConfigPath = path.join(configDir, "agents.yaml");

    const config = readAgentsConfig(agentsConfigPath);
    expect(config.agents.map((agent) => agent.id)).toEqual(["claude-default", "codex-default"]);
    expect(config.agents.map((agent) => agent.name)).toEqual(["Claude", "Codex"]);
    expect(config.agents.map((agent) => agent.backend)).toEqual(["claude", "codex"]);
    expect(config.agents.map((agent) => agent.default_preset)).toEqual([
      defaults.claude,
      defaults.codex,
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
