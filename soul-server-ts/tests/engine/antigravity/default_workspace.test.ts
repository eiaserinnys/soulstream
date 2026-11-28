import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import pino from "pino";
import { parse } from "yaml";
import { describe, expect, it, vi } from "vitest";
import { AntigravityEngineAdapter } from "../../../src/engine/antigravity/adapter.js";
import { antigravityDefinitionName } from "../../../src/engine/antigravity/agent_definition.js";
import { writeAntigravityRestrictedBundle } from "../../../src/engine/antigravity/restricted_bundle.js";
import { antigravityWorkspacePaths } from "../../../src/engine/antigravity/default_workspace.js";
import { makeTempDirSync } from "../../helpers/temp_dir.js";
import { UTONIUM_ALLOWED, UTONIUM_DENIED } from "./utonium_policy_fixture.js";

const home = makeTempDirSync("agy-default-home-");
vi.mock("node:os", async original => ({ ...await original<typeof import("node:os")>(), homedir: () => home }));
const denied = [...UTONIUM_DENIED, "Agent(general-purpose)", "Agent(Explore)", "Agent(Plan)", "Agent(claude)", "Agent(statusline-setup)"];
const sessionId = "default-session";
const name = antigravityDefinitionName(sessionId);
const prompt = `앞 줄\n${"한글".repeat(4000)}\n${"가".repeat(7000)}끝`;
const logger = pino({ level: "silent" });

function fixture(restricted = false, lateCwd = false) {
  const dir = makeTempDirSync("agy-default-");
  const state = join(dir, "state");
  const workspace = join(home, lateCwd ? "~zzz-profile" : "a-profiles", basename(dir));
  const agents = join(workspace, ".claude", "agents");
  mkdirSync(agents, { recursive: true });
  for (const agent of ["eye", "Explore"]) writeFileSync(join(agents, `${agent}.md`), `---\nname: ${agent}\ndescription: agent\ntools: Read, Bash\n---\n본문\n`);
  const executable = join(dir, "agy.mjs");
  writeFileSync(executable, `#!/usr/bin/env node
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(join(dir, "args.json"))}, JSON.stringify(process.argv.slice(2)));
const globalAgents = ${JSON.stringify(join(home, ".gemini/config/agents"))};
writeFileSync(${JSON.stringify(join(dir, "global-agents.json"))}, JSON.stringify(existsSync(globalAgents) ? readdirSync(globalAgents) : []));
for await (const chunk of process.stdin) {}
console.log(JSON.stringify({event:'init',conversation_id:'conv'}));
console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',response:'ok'}}));
`);
  chmodSync(executable, 0o700);
  const warn = vi.fn((_fields: unknown, _message: string) => {});
  const engine = new AntigravityEngineAdapter({ workspaceDir: workspace, agentId: "utonium", sessionDirectory: state,
    executablePath: executable, processEnv: process.env, profileWorkspaceDir: workspace,
    resolvedMcpServers: [{ name: "soulstream", type: "streamable_http", url: "http://localhost:1234/mcp", headers: { Authorization: "Bearer test" } }],
    internalMcpUrl: "http://localhost:1234/mcp",
    ...(restricted ? { allowedTools: UTONIUM_ALLOWED, disallowedTools: denied, claudePermissionMode: "dontAsk" as const } : {}),
  }, Object.assign(logger.child({}), { warn }));
  return { dir, state, workspace, engine, warn, overlay: join(state, "antigravity-workspace") };
}
async function run(engine: AntigravityEngineAdapter, extra: Record<string, unknown> = {}) {
  const events = [];
  for await (const event of engine.execute({ agentSessionId: sessionId, prompt: "요청", systemPrompt: prompt, model: "test-model", reasoningEffort: "low", ...extra })) events.push(event);
  expect(events.find(event => event.type === "complete")).toBeDefined();
}
function config(dir: string, file: string) { return JSON.parse(readFileSync(join(dir, ".agents", file), "utf8")); }
function runHook(command: string, input: unknown = {}) {
  return JSON.parse(execFileSync("/bin/sh", ["-c", command], { input: JSON.stringify(input), encoding: "utf8" }));
}
function hookInput(name: string, args: object) { return { toolCall: { name, args } }; }

describe("Antigravity default workspace", () => {
  it("orders the workspace outside representative profile trees and falls back for late CWDs", () => {
    const state = "/home/eias/migration/prod-state/runner/session";
    for (const cwd of ["/home/eias/workspace", "/home/eias/migration/production-staging/config/agent-workspaces/utonium", "/home/eias/workspace/.projects/worktree"]) {
      const paths = antigravityWorkspacePaths(state, cwd, "/home/eias");
      expect(paths.addDir > cwd).toBe(true);
      expect(relative(cwd, paths.addDir).startsWith("..")).toBe(true);
      expect(paths.fallback).toBe(false);
    }
    for (const cwd of ["/tmp/project", "/mnt/c/project"]) {
      const paths = antigravityWorkspacePaths(state, cwd, "/home/eias");
      expect(paths.addDir).toBe(join(state, "antigravity-workspace"));
      expect(paths.fallback).toBe(true);
    }
    expect(antigravityWorkspacePaths("/var/runner/session", "/home/eias", "/home/eias").fallback).toBe(true);
    expect(() => antigravityWorkspacePaths("/home/eias/workspace/state", "/home/eias/workspace", "/home/eias")).toThrow(/outside the profile workspace/);
  });
  it("protects session and both workspace paths even when write and edit are unrestricted", async () => {
    const f = fixture(true); await run(f.engine, { allowedTools: ["Write", "Edit"] });
    const hooks = config(f.overlay, "hooks.json");
    const gate = hooks["soulstream-session"].PreToolUse[0].hooks[0].command;
    const paths = antigravityWorkspacePaths(f.state, f.workspace, home);
    for (const root of [f.state, f.overlay, paths.addDir]) {
      for (const tool of ["write_file", "edit_file"]) {
        expect(runHook(gate, hookInput(tool, { Path: join(root, "policy.json") }))).toMatchObject({ decision: "deny", reason: "path not allowed" });
      }
    }
    const alias = join(f.dir, "session-alias");
    symlinkSync(f.state, alias);
    expect(runHook(gate, hookInput("write_file", { Path: join(alias, "antigravity-workspace", "new", "file") }))).toMatchObject({ decision: "deny", reason: "path not allowed" });
    expect(runHook(gate, hookInput("write_file", { Path: join(dirname(f.state), "allowed.txt") })).decision).toBe("allow");
    await f.engine.close();
  });
  it("launches new conversations with add-dir and keeps model and effort, without a global definition", async () => {
    const f = fixture(); await run(f.engine);
    const args = JSON.parse(readFileSync(join(f.dir, "args.json"), "utf8"));
    expect(args).not.toContain("--agent");
    const addDir = antigravityWorkspacePaths(f.state, f.workspace, home).addDir;
    expect(antigravityWorkspacePaths(join(f.dir, "other-session"), f.workspace, home).link)
      .toBe(antigravityWorkspacePaths(f.state, f.workspace, home).link);
    expect(args.slice(args.indexOf("--add-dir"), args.indexOf("--add-dir") + 2)).toEqual(["--add-dir", addDir]);
    expect(readFileSync(join(addDir, "instructions", "chunk-000000.txt"), "utf8")).toBe(readFileSync(join(f.overlay, "instructions", "chunk-000000.txt"), "utf8"));
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual(["--model", "test-model"]);
    expect(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2)).toEqual(["--effort", "low"]);
    expect(JSON.parse(readFileSync(join(f.dir, "global-agents.json"), "utf8"))).not.toContain(`${name}.md`);
    expect(existsSync(join(home, ".gemini/config/agents", `${name}.md`))).toBe(false);
    await f.engine.close();
    rmSync(f.state, { recursive: true });
    expect(existsSync(addDir)).toBe(false);
  });
  it("writes equivalent MCP servers and removes them when MCP is disabled", async () => {
    const f = fixture(); await run(f.engine);
    const servers = config(f.overlay, "mcp_config.json").mcpServers;
    expect(servers.soulstream).toEqual({ serverUrl: "http://localhost:1234/mcp/internal", headers: { Authorization: "Bearer test", "x-soulstream-agent-session-id": sessionId } });
    expect(servers["profile-utonium"]).toMatchObject({ command: process.execPath,
      args: expect.arrayContaining(["--antigravity-mcp-gateway"]),
      env: { SOULSTREAM_ANTIGRAVITY_MCP_GATEWAY_CONFIG: join(f.state, "antigravity-mcp-gateway.json") } });
    await run(f.engine, { resumeSessionId: "conv", useMcp: false });
    expect(config(f.overlay, "mcp_config.json").mcpServers).toEqual({});
    await f.engine.close();
  });
  it("injects byte-identical UTF-8 instructions in bounded chunks through the SessionStart process", async () => {
    const f = fixture(); await run(f.engine);
    const hooks = config(f.overlay, "hooks.json");
    const hook = Object.values(hooks).flatMap((entry: any) => entry.SessionStart ?? [])[0] as any;
    const steps = runHook(hook.command).injectSteps;
    const chunks = steps.map((step: any) => step.systemMessage.systemMessage);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk: string) => Buffer.byteLength(chunk) <= 19000)).toBe(true);
    expect(chunks.join("")).toBe(prompt);
    expect(readdirSync(join(f.overlay, ".agents", "rules"))).toHaveLength(1);
    await f.engine.close();
  });
  it("enforces default deny and existing path, command and MCP policy in the actual gate", async () => {
    const f = fixture(true); await run(f.engine);
    const hooks = config(f.overlay, "hooks.json");
    const hook = Object.values(hooks).flatMap((entry: any) => entry.PreToolUse ?? [])[0] as any;
    const decide = (tool: string, args: object) => runHook(hook.hooks[0].command, hookInput(tool, args)).decision;
    for (const tool of ["swarm", "define_subagent", "search_web"]) expect(decide(tool, {})).toBe("deny");
    expect(decide("run_command", { CommandLine: "rm -rf /tmp/x" })).toBe("deny");
    expect(decide("write_file", { Path: "/etc/hosts" })).toBe("deny");
    expect(decide("read_file", { Path: "/etc/hosts" })).toBe("allow");
    expect(decide("run_command", { CommandLine: `python3 /home/eias/migration/netcup-core-bootstrap/prod-state/agent-common-files/skills/seal/scripts/seal.py spec` })).toBe("allow");
    expect(decide("call_mcp_tool", { ServerName: "soulstream", ToolName: "get_card" })).toBe("allow");
    expect(decide("invoke_subagent", { TypeName: `${name}-eye` })).toBe("allow");
    expect(decide("invoke_subagent", { TypeName: "other" })).toBe("deny");
    await f.engine.close();
  });
  it("applies subagent tools only to calls from a child conversation", async () => {
    const f = fixture(true); await run(f.engine);
    const hooks = config(f.overlay, "hooks.json");
    const hook = Object.values(hooks).flatMap((entry: any) => entry.PreToolUse ?? [])[0] as any;
    const decide = (conversationId: string, tool: string, args: object) =>
      runHook(hook.hooks[0].command, { conversationId, ...hookInput(tool, args) }).decision;
    const marker = join(f.state, "antigravity-default-conversation");
    const policy = JSON.parse(readFileSync(join(f.overlay, "policy.json"), "utf8"));
    expect(policy.parentConversationFile).toBe(marker);
    expect(policy.subagentTools).toEqual(["view_file", "run_command", "send_message", "finish"]);
    writeFileSync(marker, "conv");
    expect(decide("conv", "run_command", { CommandLine: "ls" })).toBe("deny");
    expect(decide("child", "run_command", { CommandLine: "ls" })).toBe("allow");
    expect(decide("child", "read_file", { Path: "/etc/hosts" })).toBe("allow");
    expect(decide("child", "write_file", { Path: "/etc/hosts" })).toBe("deny");
    expect(decide("child", "swarm", {})).toBe("deny");
    expect(decide("child", "invoke_subagent", { TypeName: `${name}-eye` })).toBe("deny");
    expect(decide("child", "call_mcp_tool", { ServerName: "soulstream", ToolName: "get_card" })).toBe("allow");
    expect(runHook(hook.hooks[0].command, hookInput("run_command", { CommandLine: "ls" })).decision).toBe("deny");
    writeFileSync(marker, "  ");
    expect(decide("child", "run_command", { CommandLine: "ls" })).toBe("deny");
    unlinkSync(marker);
    expect(decide("child", "run_command", { CommandLine: "ls" })).toBe("deny");
    await f.engine.close();
  });
  it("creates only permitted subagents for the utonium Agent(kind) policy", async () => {
    const f = fixture(true); await run(f.engine);
    const agents = readdirSync(join(f.overlay, ".agents", "agents"));
    expect(agents).toContain(`${name}-eye.md`);
    expect(agents).not.toContain(`${name}-Explore.md`);
    const definition = readFileSync(join(f.overlay, ".agents", "agents", `${name}-eye.md`), "utf8");
    expect(parse(definition.split("---\n")[1]!)).toMatchObject({ name: `${name}-eye`, subagent: true, mainAgent: false, model: "inherit", tools: ["view_file", "run_command", "send_message", "finish"] });
    expect(definition).toContain("본문");
    await f.engine.close();
  });
  it("resumes new conversations with the same add-dir, and legacy restricted conversations with the old bundle", async () => {
    const f = fixture(true); await run(f.engine);
    await run(f.engine, { resumeSessionId: "conv", systemPrompt: undefined });
    let args = JSON.parse(readFileSync(join(f.dir, "args.json"), "utf8"));
    expect(args).toContain("--conversation"); expect(args).toContain("conv"); expect(args).toContain(antigravityWorkspacePaths(f.state, f.workspace, home).addDir); expect(args).not.toContain("--agent");
    await f.engine.close();
    const legacy = fixture(true);
    mkdirSync(legacy.state, { recursive: true });
    await writeAntigravityRestrictedBundle({ directory: join(legacy.state, "antigravity-tool-policy"), agentId: "utonium", agentSessionId: sessionId,
      systemPrompt: "legacy", gatewayConfigPath: join(legacy.state, "antigravity-mcp-gateway.json"), useMcp: false,
      allowedTools: UTONIUM_ALLOWED, disallowedTools: UTONIUM_DENIED, profileWorkspaceDir: legacy.workspace, logger });
    await run(legacy.engine, { resumeSessionId: "old", systemPrompt: undefined });
    args = JSON.parse(readFileSync(join(legacy.dir, "args.json"), "utf8"));
    expect(args).toContain("--conversation"); expect(args).toContain("old"); expect(args).not.toContain("--add-dir"); expect(args).not.toContain("--agent");
    expect(JSON.parse(readFileSync(join(legacy.dir, "global-agents.json"), "utf8"))).toContain(`${name}.md`);
    expect(existsSync(join(home, ".gemini/config/agents", `${name}.md`))).toBe(false);
    expect(existsSync(join(legacy.state, "antigravity-tool-policy", "agents", `${name}.md`))).toBe(true);
    await legacy.engine.close();
  });
  it("warns and keeps the old location when the CWD sorts later", async () => {
    const f = fixture(false, true); await run(f.engine);
    const args = JSON.parse(readFileSync(join(f.dir, "args.json"), "utf8"));
    expect(args[args.indexOf("--add-dir") + 1]).toBe(f.overlay);
    expect(f.warn).toHaveBeenCalledOnce();
    expect(f.warn.mock.calls[0]![1]).toMatch(/workspace.*order/i);
    await f.engine.close();
  });
  it("resumes an existing marked conversation through the new path and retains its instructions", async () => {
    const f = fixture();
    mkdirSync(join(f.overlay, "instructions"), { recursive: true });
    writeFileSync(join(f.overlay, "instructions", "chunk-000000.txt"), "기존 지침");
    writeFileSync(join(f.state, "antigravity-default-conversation"), "conv");
    await run(f.engine, { resumeSessionId: "conv", systemPrompt: undefined });
    const args = JSON.parse(readFileSync(join(f.dir, "args.json"), "utf8"));
    const addDir = antigravityWorkspacePaths(f.state, f.workspace, home).addDir;
    expect(args[args.indexOf("--add-dir") + 1]).toBe(addDir);
    expect(readFileSync(join(addDir, "instructions", "chunk-000000.txt"), "utf8")).toBe("기존 지침");
    await f.engine.close();
  });
});
