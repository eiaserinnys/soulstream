import { describe, expect, it } from "vitest";
import { AgentRegistry } from "../../src/agent_registry.js";
import { isPortableMcpNode } from "../../src/mcp_central/state.js";
import { buildRegistrationMsg } from "../../src/upstream/registration.js";
import { McpConfigCommands } from "../../src/upstream/mcp_config_commands.js";

describe("portable central MCP contract", () => {
  it.each([
    [{ PORTABLE_LOCAL_MCP_AUTHORIZATION: "fake" }, {}, false],
    [{}, {}, false],
    [{ SOULSTREAM_PORTABLE_NODE: "1" }, {}, true],
    [{ PORTABLE_LOCAL_MCP_AUTHORIZATION: "fake" }, { model_catalog_path: "/catalog" }, true],
  ])("uses one classification for registration and sync", async (env, manifest, expected) => {
    const portable = isPortableMcpNode(env, manifest);
    expect(portable).toBe(expected);
    const msg = buildRegistrationMsg({ nodeId: "test", host: "localhost", port: 1, userName: "", agentRegistry: new AgentRegistry([]), isPortableNode: portable });
    expect(Boolean(msg.capabilities.central_mcp_config_v1)).toBe(!expected);
    const commands = new McpConfigCommands(undefined, undefined, portable);
    await expect(commands.sync({})).rejects.toMatchObject({ code: expected ? "MCP_PORTABLE_NODE" : "INVALID_MCP_CENTRAL_SYNC" });
  });
});

it("uses the installer-rendered environment and actual catalog-free manifest", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, resolve, dirname } = await import("node:path");
  const { parse } = await import("dotenv");
  const { HOST_RELEASE_ARTIFACTS } = await import("../../src/release/release_artifacts.js");
  const { RUNNER_RELEASE_ARTIFACTS } = await import("../../src/runner/runner_release_materializer.js");
  const dir = mkdtempSync(join(tmpdir(), "installer-central-"));
  const root = join(dir, "root"), dist = join(dir, "dist");
  mkdirSync(join(root, "config"), { recursive: true });
  const catalog = join(root, "packages/model-catalog/data");
  mkdirSync(catalog, { recursive: true });
  copyFileSync(resolve("../packages/model-catalog/data/model-catalog.yaml"), join(catalog, "model-catalog.yaml"));
  const names = ["skill_catalog", "domain_catalog", "common_rules", "common_rules_extra", "common_rules_templates", "codex_rules", "claude_common_rules", "coding_common_rules", "coding_common_rules_extra", "seosoyoung_rules", "seosoyoung_general", "seosoyoung_skills", "seosoyoung_rules_pas", "seosoyoung_skills_pas", "seosoyoung_rules_extra_pas", "card_work_skill_body", "node_model_selection_body", "card_orchestrator_root", "projects_root", "mistakes_root"];
  writeFileSync(join(root, "config", ".atom-seed-map.json"), JSON.stringify(Object.fromEntries(names.map((n, i) => [n, `${(i + 1).toString(16).padStart(8, "0")}-aaaa-4bbb-8ccc-${String(i + 1).padStart(12, "0")}`]))));
  writeFileSync(join(root, ".atom-api-key"), "test-atom-key_0123456789abcdef\n");
  try {
    execFileSync("bash", ["-c", 'source "$1"; BACKENDS=codex; prepare_secrets "$3" "$2/atom"; render_config "$2" "$3"', "bash", resolve("../install/install.sh"), dir, root]);
    const envFile = join(root, ".env.soul-server-ts");
    const env = parse(readFileSync(envFile));
    for (const file of [...HOST_RELEASE_ARTIFACTS, ...RUNNER_RELEASE_ARTIFACTS.map((name) => `runner/${name}`)]) {
      const path = join(dist, file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "fixture");
    }
    execFileSync(process.execPath, [resolve("node_modules/tsx/dist/cli.mjs"), "scripts/write_release_manifest.ts", "--dist-root", dist, "--env-file", envFile]);
    const manifest = JSON.parse(readFileSync(join(dist, "release-manifest.json"), "utf8"));
    expect(manifest.model_catalog_path).toBeUndefined();
    const portable = isPortableMcpNode(env, manifest);
    expect(portable).toBe(false);
    const msg = buildRegistrationMsg({ nodeId: "test", host: "localhost", port: 1, userName: "", agentRegistry: new AgentRegistry([]), isPortableNode: portable });
    expect(msg.capabilities.central_mcp_config_v1).toBe(true);
    const { McpConfigService } = await import("../../src/mcp_config_service.js");
    const service = new McpConfigService({ agentsConfigPath: join(root, "config/agents.yaml"), processEnv: env, isPortableNode: portable });
    const snapshot = { registry: { servers: [] }, profiles: { profiles: [] }, agent_bindings: {} };
    await expect(new McpConfigCommands(service, () => {}, portable).sync({ type: "mcp_central_sync", requestId: "test", revision: 1, runtime: snapshot, display: snapshot })).resolves.toMatchObject({ success: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("uses the new launcher's actual child environment for registration and sync", async () => {
  // @ts-expect-error portable launcher is an ESM JavaScript package
  const { buildChildEnv } = await import("../../../portable-node/lib/environment.mjs");
  const runtime = { executable: "/tmp/fake/bin" };
  const env = buildChildEnv({ stateRoot: "/tmp/fake", defaults: { node_ws_url: "ws://localhost" }, node: { node_id: "new", token: "fake" }, configDir: "/tmp/fake/config", releaseDir: "/tmp/fake/release", runtimes: { node: runtime, python: runtime, claude: runtime, codex: runtime }, ports: { host: 1234, mcp: 1235 } });
  expect(env.SOULSTREAM_PORTABLE_NODE).toBe("1");
  const portable = isPortableMcpNode(env, {});
  expect(portable).toBe(true);
  expect(buildRegistrationMsg({ nodeId: "new", host: "localhost", port: 1, userName: "", agentRegistry: new AgentRegistry([]), isPortableNode: portable }).capabilities).not.toHaveProperty("central_mcp_config_v1");
  await expect(new McpConfigCommands(undefined, undefined, portable).sync({})).rejects.toMatchObject({ code: "MCP_PORTABLE_NODE" });
});
