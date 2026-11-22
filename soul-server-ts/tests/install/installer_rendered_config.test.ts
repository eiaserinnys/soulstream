import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

describe("installer configuration", () => {
  it.each(["claude", "codex", "antigravity", "claude,codex,antigravity"])("loads %s using the worker parsers", (backends) => {
    const dir = mkdtempSync(join(tmpdir(), "installer-worker-"));
    const home = join(dir, "home"), root = join(home, "soulstream");
    try {
      execFileSync("bash", ["-c", 'source "$1"; BACKENDS="$4"; render_config "$2" "$3"', "bash", resolve("../install/install.sh"), home, root, backends]);
      const raw = parse(readFileSync(join(root, ".env.soul-server-ts")));
      const parsed = parseEnv(raw);
      expect(parsed.SOULSTREAM_BACKENDS).toEqual(backends.split(","));
      expect(parsed.CLAUDE_ACCOUNT_POOL_ENABLED).toBe(false);
      expect(Boolean(parsed.CLAUDE_AUTH_TOKEN_PATH)).toBe(backends.split(",").includes("claude"));
      expect(raw.CLAUDE_CODE_EXECPATH).toBeUndefined();
      expect(raw.CODEX_CLI_PATH).toBeUndefined();
      const agentsPath = join(root, "config", "agents.yaml");
      const agents = loadAgentRegistry(agentsPath).list();
      expect(agents.map((agent) => agent.backend)).toEqual(backends.split(","));
      const mcp = new McpConfigService({ agentsConfigPath: agentsPath, processEnv: raw });
      expect(mcp.readRegistry().servers).toHaveLength(1);
      expect(mcp.readProfiles().profiles).toHaveLength(1);
      for (const agent of agents) {
        const server = mcp.resolveMcpProfile(agent)?.mcp_servers[0];
        expect(server).toMatchObject({ type: "streamable_http", url: "http://127.0.0.1:4205/mcp", headers: { Authorization: raw.PORTABLE_LOCAL_MCP_AUTHORIZATION } });
      }
      for (const executable of ["claude", "codex", "agy"]) writeFileSync(join(dir, executable), "#!/bin/sh\n", { mode: 0o755 });
      const pathEnv = { PATH: `${dir}:${process.env.PATH ?? ""}`, HOME: home };
      expect(resolveClaudeExecutableFromPath(pathEnv, "linux")).toBe(join(dir, "claude"));
      expect(resolveCodexCliPath(undefined, pathEnv, "linux")).toMatchObject({ path: join(dir, "codex"), source: "PATH" });
      expect(resolveAntigravityCliPath(pathEnv, "linux")).toMatchObject({ path: join(dir, "agy"), source: "PATH" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
