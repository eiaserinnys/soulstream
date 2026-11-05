import { existsSync, readFileSync, statSync, chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it, vi } from "vitest";
import { antigravityMcpGatewayUpstreams, writeAntigravityAgentDefinition, writeAntigravityMcpGatewayConfig } from "../../../src/engine/antigravity/agent_definition.js";
import { ANTIGRAVITY_AGENT_TOOLS } from "../../../src/engine/antigravity/agent_tools.js";
import { makeTempDirSync } from "../../helpers/temp_dir.js";

const testHome = makeTempDirSync("agy-definition-home-");
vi.mock("node:os", async importOriginal => ({ ...await importOriginal<typeof import("node:os")>(), homedir: () => testHome }));
const launch = { command: "/absolute/node", args: ["/absolute/runner.js", "--antigravity-mcp-gateway"] };
const logger = { warn: vi.fn() };
const base = { agentId: "Test_Agent", agentSessionId: "session-test", systemPrompt: "한글 지시",
  gatewayConfigPath: "/absolute/gateway.json", mcpGatewayLaunch: launch, logger };
const servers = [
  { name: "alpha", type: "streamable_http" as const, url: "http://localhost:4321/probe", headers: { Authorization: "fixture-secret" } },
  { name: "soulstream", type: "streamable_http" as const, url: "http://old.invalid/mcp", headers: { Authorization: "fixture-secret" } },
  { name: "beta", type: "stdio" as const, command: "node", args: ["probe.mjs"], env: { PROBE: "표식" }, cwd: "/tmp/probe" },
  { name: "legacy", type: "sse" as const, url: "http://secret.invalid" },
];
const frontmatter = (file: string) => parse(readFileSync(file, "utf8").split("---\n")[1]!);

describe("Antigravity gateway definition", () => {
  it("writes internal and one gateway only, securely, and removes only its definition", async () => {
    const definition = await writeAntigravityAgentDefinition({ ...base, resolvedMcpServers: servers, internalMcpUrl: "http://127.0.0.1:4206/mcp" });
    const file = join(definition.directory, `${definition.name}.md`);
    const parsed = frontmatter(file);
    expect(parsed.tools).toEqual([...ANTIGRAVITY_AGENT_TOOLS]);
    expect(parsed.mcpServers).toEqual([
      { name: "soulstream", url: "http://127.0.0.1:4206/mcp/internal", headers: { Authorization: "fixture-secret", "x-soulstream-agent-session-id": "session-test" } },
      { name: "profile-test-agent", ...launch, env: { SOULSTREAM_ANTIGRAVITY_MCP_GATEWAY_CONFIG: base.gatewayConfigPath } },
    ]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    await definition.remove();
    expect(existsSync(file)).toBe(false);
  });
  it("always reserves the gateway for enabled empty profiles and omits all MCP when disabled", async () => {
    const empty = await writeAntigravityAgentDefinition(base);
    expect(frontmatter(join(empty.directory, `${empty.name}.md`)).mcpServers).toHaveLength(1);
    await empty.remove();
    const disabled = await writeAntigravityAgentDefinition({ ...base, useMcp: false });
    expect(frontmatter(join(disabled.directory, `${disabled.name}.md`)).mcpServers).toEqual([]);
    await disabled.remove();
    await expect(writeAntigravityAgentDefinition({ ...base, mcpGatewayLaunch: undefined })).rejects.toThrow(/proxy launch/i);
  });
  it("preserves existing definition directory permissions", async () => {
    const first = await writeAntigravityAgentDefinition(base);
    chmodSync(first.directory, 0o750);
    const second = await writeAntigravityAgentDefinition({ ...base, systemPrompt: "둘째" });
    expect(first.name).toBe(second.name);
    expect(statSync(second.directory).mode & 0o777).toBe(0o750);
    expect(readFileSync(join(second.directory, `${second.name}.md`), "utf8")).toContain("둘째");
    await second.remove();
  });
  it("preserves large UTF-8 instructions and removes only its own file", async () => {
    const systemPrompt = "한글 시스템 지시\n".repeat(10000);
    const definition = await writeAntigravityAgentDefinition({ ...base, systemPrompt });
    const file = join(definition.directory, `${definition.name}.md`);
    const neighbor = join(definition.directory, "other.md");
    writeFileSync(neighbor, "unrelated");
    expect(readFileSync(file, "utf8")).toContain(systemPrompt);
    expect(Buffer.byteLength(systemPrompt)).toBeGreaterThan(100000);
    await definition.remove();
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(neighbor, "utf8")).toBe("unrelated");
  });
  it("converts external transports, skips SSE and writes a persistent private config", async () => {
    logger.warn.mockClear();
    const upstreams = antigravityMcpGatewayUpstreams({ resolvedMcpServers: servers, logger });
    expect(upstreams).toEqual([
      { name: "alpha", upstream: { type: "streamable_http", url: servers[0]!.url, headers: { Authorization: "fixture-secret" } } },
      { name: "beta", upstream: { type: "stdio", command: "node", args: ["probe.mjs"], env: { PROBE: "표식" }, cwd: "/tmp/probe" } },
    ]);
    expect(logger.warn).toHaveBeenCalledWith({ serverName: "legacy" }, expect.any(String));
    expect(antigravityMcpGatewayUpstreams({ resolvedMcpServers: servers, useMcp: false, logger })).toEqual([]);
    const path = join(makeTempDirSync("gateway-config-"), "config.json");
    await writeAntigravityMcpGatewayConfig(path, upstreams);
    chmodSync(path, 0o644);
    await writeAntigravityMcpGatewayConfig(path, upstreams.slice(1));
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 1, servers: upstreams.slice(1) });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
  it("rejects invalid external configuration with the existing messages", () => {
    const invalid = [
      [{ type: "stdio", command: "node" }, "name is required"],
      [{ name: "bad__name", type: "stdio", command: "node" }, 'name must not contain "__"'],
      [{ name: "x", type: "stdio" }, "requires command and args"],
      [{ name: "x", type: "stdio", command: "node", full_command: "node x" }, "requires command and args"],
      [{ name: "x", type: "streamable_http" }, "requires a URL"],
    ] as const;
    for (const [server, message] of invalid) {
      expect(() => antigravityMcpGatewayUpstreams({ resolvedMcpServers: [server as never], logger })).toThrow(message);
    }
  });
});
