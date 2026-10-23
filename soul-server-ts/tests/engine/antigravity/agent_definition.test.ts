import { existsSync, readFileSync, statSync, mkdirSync, chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import { parse } from "yaml";
import { describe, expect, it, vi } from "vitest";
import { writeAntigravityAgentDefinition } from "../../../src/engine/antigravity/agent_definition.js";
import { ANTIGRAVITY_AGENT_TOOLS } from "../../../src/engine/antigravity/agent_tools.js";
import type { AntigravityMcpProxyLaunch } from "../../../src/engine/antigravity/mcp_schema_proxy_launch.js";
import { makeTempDirSync } from "../../helpers/temp_dir.js";

const testHome = makeTempDirSync("agy-definition-home-");
vi.mock("node:os", async importOriginal => ({ ...await importOriginal<typeof import("node:os")>(), homedir: () => testHome }));

describe("user-level session-specific Antigravity definition", () => {
  it("writes large UTF-8 system instructions, all 26 tools, MCP fields, secure modes and removes only its file", async () => {
    const sessionDirectory = makeTempDirSync("agy-definition-");
    const warn = vi.fn();
    const systemPrompt = "한글 시스템 지시\n".repeat(10000);
    const mcpProxyLaunch: AntigravityMcpProxyLaunch = {
      command: "/absolute/node",
      args: ["/absolute/runner/runner_entry.js", "--antigravity-mcp-schema-proxy"],
    };
    const definition = await writeAntigravityAgentDefinition({
      agentSessionId: "session-test", systemPrompt,
      internalMcpUrl: "http://127.0.0.1:4206/mcp", useMcp: true,
      mcpProxyLaunch,
      resolvedMcpServers: [
        { name: "http", type: "streamable_http", url: "http://localhost:4321/probe", headers: { "x-test": "fixture-secret" } },
        { name: "soulstream", type: "streamable_http", url: "http://obsolete.invalid/mcp", headers: { Authorization: "fixture-secret" } },
        { name: "stdio", type: "stdio", command: "node", args: ["probe.mjs"], env: { PROBE: "표식" }, cwd: "/tmp/probe" },
        { name: "legacy", type: "sse", url: "http://secret.invalid", headers: { Authorization: "hidden" } },
      ], logger: { warn } as unknown as ReturnType<typeof pino>,
    });
    const file = join(testHome, ".gemini/config/agents", `${definition.name}.md`);
    expect(definition.directory).toBe(join(testHome, ".gemini/config/agents"));
    const text = readFileSync(file, "utf8");
    const frontmatter = parse(text.split("---\n")[1]!);
    expect(text).toContain(systemPrompt);
    expect(Buffer.byteLength(systemPrompt)).toBeGreaterThan(100000);
    expect(frontmatter).toMatchObject({ name: definition.name, mainAgent: true, subagent: false, tools: [...ANTIGRAVITY_AGENT_TOOLS] });
    expect(frontmatter.tools).toHaveLength(26);
    expect(frontmatter.tools).toEqual(expect.arrayContaining(["ask_question", "ask_permission", "ask_custom_permission", "run_command", "write_to_file"]));
    expect(frontmatter.mcpServers).toEqual([
      { name: "http", command: mcpProxyLaunch.command, args: mcpProxyLaunch.args,
        env: { SOULSTREAM_ANTIGRAVITY_MCP_UPSTREAM: JSON.stringify({ type: "streamable_http",
          url: "http://localhost:4321/probe", headers: { "x-test": "fixture-secret" } }) } },
      { name: "soulstream", url: "http://127.0.0.1:4206/mcp/internal", headers: { Authorization: "fixture-secret", "x-soulstream-agent-session-id": "session-test" } },
      { name: "stdio", command: mcpProxyLaunch.command, args: mcpProxyLaunch.args,
        env: { SOULSTREAM_ANTIGRAVITY_MCP_UPSTREAM: JSON.stringify({ type: "stdio", command: "node",
          args: ["probe.mjs"], env: { PROBE: "표식" }, cwd: "/tmp/probe" }) } },
    ]);
    for (const server of frontmatter.mcpServers.filter((x: { command?: string }) => x.command === mcpProxyLaunch.command)) {
      expect(server.args).not.toContain("fixture-secret");
      expect(server.cwd).toBeUndefined();
    }
    expect(statSync(definition.directory).mode & 0o777).toBe(0o700);
    const neighbor = join(definition.directory, "other.md");
    writeFileSync(neighbor, "unrelated");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secret.invalid|fixture-secret|hidden/);
    expect(warn).toHaveBeenCalledWith({ serverName: "legacy" }, expect.any(String));
    await definition.remove();
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(neighbor, "utf8")).toBe("unrelated");
    expect(existsSync(sessionDirectory)).toBe(true);
  });
  it("preserves existing directory permissions and overwrites the same session file", async () => {
    const directory = join(testHome, ".gemini/config/agents");
    mkdirSync(directory, { recursive: true }); chmodSync(directory, 0o750);
    const options = { agentSessionId: "overwrite", systemPrompt: "첫째", logger: pino({ level: "silent" }) };
    const first = await writeAntigravityAgentDefinition(options);
    const second = await writeAntigravityAgentDefinition({ ...options, systemPrompt: "둘째" });
    expect(first.name).toBe(second.name);
    expect(statSync(directory).mode & 0o777).toBe(0o750);
    expect(readFileSync(join(directory, `${second.name}.md`), "utf8")).toContain("둘째");
    await second.remove();
  });
  it("disables MCP on a newly created conversation", async () => {
    const definition = await writeAntigravityAgentDefinition({ agentSessionId: "session", systemPrompt: "지시", useMcp: false,
      resolvedMcpServers: [{ type: "streamable_http", name: "probe", url: "http://localhost:4321" }], logger: pino({ level: "silent" }) });
    expect(readFileSync(join(definition.directory, `${definition.name}.md`), "utf8")).not.toContain("localhost");
    await definition.remove();
  });
  it("requires the proxy launch only for enabled external HTTP and stdio servers", async () => {
    await expect(writeAntigravityAgentDefinition({ agentSessionId: "missing-proxy", systemPrompt: "지시",
      resolvedMcpServers: [{ name: "external", type: "streamable_http", url: "http://localhost:4321" }],
      logger: pino({ level: "silent" }) })).rejects.toThrow(/proxy launch/i);
    const definition = await writeAntigravityAgentDefinition({ agentSessionId: "internal-only", systemPrompt: "지시",
      internalMcpUrl: "http://127.0.0.1:4206/mcp",
      resolvedMcpServers: [{ name: "soulstream", type: "streamable_http", url: "http://obsolete.invalid/mcp" }],
      logger: pino({ level: "silent" }) });
    await definition.remove();
  });
});
