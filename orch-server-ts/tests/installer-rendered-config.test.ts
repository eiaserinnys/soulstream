import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import { resolveDashboardLoginMode } from "../src/auth/login_mode.js";
import { loadOrchServerEnvironment, toOrchServerTsConfig } from "../src/config.js";

describe("installer orchestrator configuration", () => {
  it.each(["claude", "codex", "antigravity", "claude,codex,antigravity"])("loads %s", (backends) => {
    const dir = mkdtempSync(join(tmpdir(), "installer-orch-"));
    const home = join(dir, "home"), root = join(home, "soulstream");
    try {
      execFileSync("bash", ["-c", 'source "$1"; BACKENDS="$4"; render_config "$2" "$3"', "bash", resolve("../install/install.sh"), home, root, backends]);
      const raw = parseEnv(readFileSync(join(root, ".env.orch"), "utf8"));
      const env = loadOrchServerEnvironment(raw);
      expect(toOrchServerTsConfig(env)).toBeDefined();
      expect(resolveDashboardLoginMode(env)).toBe("password");
      expect(env.default_execution_node_id).toBe("local");
      expect(env.default_pas_agent_id).toBe(`${backends.split(",")[0]}-default`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
