import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import { resolveDashboardLoginMode } from "../src/auth/login_mode.js";
import { loadOrchServerEnvironment, toOrchServerTsConfig } from "../src/config.js";
import { DEFAULT_DOMAIN_CATALOG_NODE_ID, DEFAULT_SKILL_CATALOG_NODE_ID } from "../src/skills/skill_catalog.js";

// The installer reads the U10 seed map and the issued atom API key before it renders configuration.
const SEED_NAMES = ["skill_catalog", "domain_catalog", "common_rules", "common_rules_extra", "common_rules_templates", "codex_rules",
  "claude_common_rules", "coding_common_rules", "coding_common_rules_extra", "seosoyoung_rules", "seosoyoung_general",
  "seosoyoung_skills", "seosoyoung_rules_pas", "seosoyoung_skills_pas", "seosoyoung_rules_extra_pas", "card_work_skill_body",
  "node_model_selection_body", "card_orchestrator_root", "projects_root", "mistakes_root"];
const FULL_MAP: Record<string, string> = Object.fromEntries(SEED_NAMES.map((name, index) =>
  [name, `${(index + 1).toString(16).padStart(8, "0")}-aaaa-4bbb-8ccc-${String(index + 1).padStart(12, "0")}`]));
const API_KEY = "test-atom-key_0123456789abcdef";
const RENDER = 'source "$1"; BACKENDS="$4"; prepare_secrets "$3" "$2/atom"; render_config "$2" "$3"';

function renderOrchEnv(prefix: string, backends: string, map: Record<string, string>, setup = "") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const home = join(dir, "home"), root = join(home, "soulstream");
  mkdirSync(join(root, "config"), { recursive: true });
  const catalogDir = join(root, "packages/model-catalog/data");
  mkdirSync(catalogDir, { recursive: true });
  copyFileSync(resolve("../packages/model-catalog/data/model-catalog.yaml"), join(catalogDir, "model-catalog.yaml"));
  cpSync(resolve("../install/common-files"), join(root, "install/common-files"), { recursive: true });
  writeFileSync(join(root, "config", ".atom-seed-map.json"), JSON.stringify(map));
  writeFileSync(join(root, ".atom-api-key"), `${API_KEY}\n`);
  try {
    execFileSync("bash", ["-c", `${setup}${RENDER}`, "bash", resolve("../install/install.sh"), home, root, backends]);
    return parseEnv(readFileSync(join(root, ".env.orch"), "utf8"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("installer orchestrator configuration", () => {
  it("loads Tailscale installer configuration without a password", () => {
    const raw = renderOrchEnv("installer-tailscale-", "codex", FULL_MAP, "TAILSCALE=true; TAILSCALE_DNS=node.tailnet.ts.net; TAILSCALE_USER=owner@example.com; ");
    const env = loadOrchServerEnvironment(raw);
    expect(resolveDashboardLoginMode(env)).toBe("tailscale");
    expect(raw.DASHBOARD_ADMIN_PASSWORD).toBeUndefined();
  });
  it.each(["claude", "codex", "antigravity", "claude,codex,antigravity"])("loads %s", (backends) => {
    const env = loadOrchServerEnvironment(renderOrchEnv("installer-orch-", backends, FULL_MAP));
    expect(toOrchServerTsConfig(env)).toBeDefined();
    expect(resolveDashboardLoginMode(env)).toBe("password");
    expect(env.default_execution_node_id).toBe("local");
    expect(env.default_pas_agent_id).toBe("seosoyoung-pas");
    expect(env.atom_enabled).toBe(true);
    expect(env.atom_server_url).toBe("http://127.0.0.1:4200");
    expect(env.skill_catalog_node_id).toBe(FULL_MAP.skill_catalog);
    expect(env.domain_catalog_node_id).toBe(FULL_MAP.domain_catalog);
  });
  it("keeps empty catalog ids instead of the production defaults when the seed map is empty", () => {
    const env = loadOrchServerEnvironment(renderOrchEnv("installer-orch-empty-", "claude", {}));
    expect(toOrchServerTsConfig(env)).toBeDefined();
    expect(env.skill_catalog_node_id).toBe("");
    expect(env.domain_catalog_node_id).toBe("");
    expect(env.skill_catalog_node_id).not.toBe(DEFAULT_SKILL_CATALOG_NODE_ID);
    expect(env.domain_catalog_node_id).not.toBe(DEFAULT_DOMAIN_CATALOG_NODE_ID);
  });
});
