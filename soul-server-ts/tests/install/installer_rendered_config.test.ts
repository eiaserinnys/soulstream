import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "dotenv";
import { describe, expect, it } from "vitest";
import { resolveCodexCliPath } from "@soulstream/executable-path";
import { loadAgentRegistry } from "../../src/agent_registry.js";
import { parseEnv } from "../../src/config.js";
import { resolveClaudeExecutableFromPath } from "../../src/engine/claude_executable_path.js";
import { resolveAntigravityCliPath } from "../../src/engine/antigravity_cli_path.js";
import { McpConfigService } from "../../src/mcp_config_service.js";

// The installer reads the U10 seed map and the issued atom API key before it renders configuration.
const SEED_NAMES = ["skill_catalog", "domain_catalog", "common_rules", "common_rules_extra", "common_rules_templates", "codex_rules",
  "claude_common_rules", "coding_common_rules", "coding_common_rules_extra", "seosoyoung_rules", "seosoyoung_general",
  "seosoyoung_skills", "seosoyoung_rules_pas", "seosoyoung_skills_pas", "seosoyoung_rules_extra_pas", "card_work_skill_body",
  "node_model_selection_body", "card_orchestrator_root", "projects_root", "mistakes_root"];
const SEED_MAP: Record<string, string> = Object.fromEntries(SEED_NAMES.map((name, index) =>
  [name, `${(index + 1).toString(16).padStart(8, "0")}-aaaa-4bbb-8ccc-${String(index + 1).padStart(12, "0")}`]));
const API_KEY = "test-atom-key_0123456789abcdef";

const EXPECTED_PROFILES: Record<string, Array<[string, string]>> = {
  claude: [["seosoyoung", "claude"], ["seosoyoung-pas", "claude"], ["card-orchestrator", "claude"], ["claude-default", "claude"]],
  codex: [["seosoyoung", "codex"], ["seosoyoung-pas", "codex"], ["codex-default", "codex"]],
  antigravity: [["seosoyoung", "antigravity"], ["seosoyoung-pas", "antigravity"], ["antigravity-default", "antigravity"]],
  "claude,codex,antigravity": [["seosoyoung", "claude"], ["seosoyoung-pas", "claude"], ["card-orchestrator", "claude"],
    ["claude-default", "claude"], ["codex-default", "codex"], ["antigravity-default", "antigravity"]],
};

describe("installer configuration", () => {
  it.each(Object.keys(EXPECTED_PROFILES))("loads %s using the worker parsers", (backends) => {
    const dir = mkdtempSync(join(tmpdir(), "installer-worker-"));
    const home = join(dir, "home"), root = join(home, "soulstream");
    mkdirSync(join(root, "config"), { recursive: true });
    const catalogDir = join(root, "packages/model-catalog/data");
    mkdirSync(catalogDir, { recursive: true });
    copyFileSync(resolve("../packages/model-catalog/data/model-catalog.yaml"), join(catalogDir, "model-catalog.yaml"));
    writeFileSync(join(root, "config", ".atom-seed-map.json"), JSON.stringify(SEED_MAP));
    writeFileSync(join(root, ".atom-api-key"), `${API_KEY}\n`);
    try {
      execFileSync("bash", ["-c", 'source "$1"; BACKENDS="$4"; prepare_secrets "$3" "$2/atom"; render_config "$2" "$3"', "bash", resolve("../install/install.sh"), home, root, backends]);
      const raw = parse(readFileSync(join(root, ".env.soul-server-ts")));
      const parsed = parseEnv(raw);
      expect(parsed.SOULSTREAM_BACKENDS).toEqual(backends.split(","));
      expect(parsed.CLAUDE_ACCOUNT_POOL_ENABLED).toBe(false);
      expect(Boolean(parsed.CLAUDE_AUTH_TOKEN_PATH)).toBe(backends.split(",").includes("claude"));
      expect(parsed.ATOM_ENABLED).toBe(true);
      expect(parsed.ATOM_SERVER_URL).toBe("http://127.0.0.1:4200");
      expect(parsed.ATOM_API_KEY).toBe(API_KEY);
      expect(raw.CLAUDE_CODE_EXECPATH).toBeUndefined();
      expect(raw.CODEX_CLI_PATH).toBeUndefined();
      const agentsPath = join(root, "config", "agents.yaml");
      const agents = loadAgentRegistry(agentsPath).list();
      expect(agents.map((agent) => [agent.id, agent.backend])).toEqual(EXPECTED_PROFILES[backends]);
      const mcp = new McpConfigService({ agentsConfigPath: agentsPath, processEnv: raw });
      expect(mcp.readRegistry().servers.map((server) => server.id)).toEqual(["soulstream", "atom"]);
      expect(mcp.readProfiles().profiles.map((profile) => profile.id)).toEqual(["default", "pas"]);
      for (const agent of agents) {
        if (agent.id === "card-orchestrator") {
          expect(agent.mcp_profile).toBeUndefined();
          continue;
        }
        const servers = mcp.resolveMcpProfile(agent)?.mcp_servers;
        expect(servers).toHaveLength(2);
        expect(servers?.[0]).toMatchObject({ type: "streamable_http", url: "http://127.0.0.1:4205/mcp", headers: { Authorization: raw.PORTABLE_LOCAL_MCP_AUTHORIZATION } });
        expect(servers?.[1]).toMatchObject({ type: "streamable_http", url: "http://127.0.0.1:4200/mcp", headers: { "x-api-key": raw.ATOM_API_KEY } });
      }
      // The PAS profile's atom contexts pass the worker's profile schema.
      const pasContexts = agents.find((agent) => agent.id === "seosoyoung-pas")?.atom_contexts;
      expect(pasContexts).toHaveLength(backends.startsWith("antigravity") ? 5 : 6);
      expect(pasContexts?.find((context) => context.node_id === SEED_MAP.seosoyoung_rules_extra_pas)).toMatchObject({ mode: "index" });
      for (const executable of ["claude", "codex", "agy"]) writeFileSync(join(dir, executable), "#!/bin/sh\n", { mode: 0o755 });
      const pathEnv = { PATH: `${dir}:${process.env.PATH ?? ""}`, HOME: home };
      expect(resolveClaudeExecutableFromPath(pathEnv, "linux")).toBe(join(dir, "claude"));
      expect(resolveCodexCliPath(undefined, pathEnv, "linux")).toMatchObject({ path: join(dir, "codex"), source: "PATH" });
      expect(resolveAntigravityCliPath(pathEnv, "linux")).toMatchObject({ path: join(dir, "agy"), source: "PATH" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
