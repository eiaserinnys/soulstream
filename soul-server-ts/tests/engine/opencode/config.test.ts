import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseModelCatalogYaml } from "@soulstream/model-catalog";
import { prepareOpenCodeSession } from "../../../src/engine/opencode/config.js";
import { makeTempDirSync } from "../../helpers/temp_dir.js";

describe("OpenCode session configuration", () => {
  it("writes isolated config, default-tool permissions, session instructions, and supported MCP shapes", async () => {
    const root = makeTempDirSync("opencode-config-");
    const sessionDirectory = join(root, "session");
    const systemPrompt = "한글 지시 OPENCode_INSTRUCTIONS_398";
    const prepared = await prepareOpenCodeSession({
      workspaceDir: join(root, "workspace"),
      model: "opencode/deepseek-v4.1-flash-free",
      sessionDirectory,
      agentSessionId: "session-config-398",
      systemPrompt,
      allowedTools: ["shell"],
      disallowedTools: ["read"],
      useMcp: true,
      internalMcpUrl: "http://127.0.0.1:4206/mcp",
      resolvedMcpServers: [
        { type: "streamable_http", name: "soulstream", url: "http://obsolete.invalid/mcp", headers: { Authorization: "fixture-secret", "x-soulstream-agent-session-id": "stale" } },
        { type: "streamable_http", name: "remote", url: "https://mcp.example.test/tools", headers: { "x-test": "remote-secret" } },
        { type: "stdio", name: "local", command: "node", args: ["probe.mjs"], env: { PROBE: "표식" }, cwd: join(root, "mcp") },
      ],
      processEnv: {
        PATH: "/usr/bin",
        HOME: "/home/test",
        LANG: "C.UTF-8",
        OPENCODE_API_KEY: "must-not-pass",
        ANTHROPIC_API_KEY: "must-not-pass",
      },
    });

    const config = JSON.parse(readFileSync(prepared.configPath, "utf8")) as Record<string, unknown>;
    const instructionPath = join(sessionDirectory, "opencode", "system-prompt.md");
    expect(config).toMatchObject({
      model: "opencode/deepseek-v4.1-flash-free",
      small_model: "opencode/deepseek-v4.1-flash-free",
      share: "disabled",
      autoupdate: false,
      instructions: [instructionPath],
      permission: { "*": "allow", question: "deny", plan_exit: "deny" },
      mcp: {
        soulstream: {
          type: "remote",
          url: "http://127.0.0.1:4206/mcp/internal",
          headers: { Authorization: "fixture-secret", "x-soulstream-agent-session-id": "session-config-398" },
          oauth: false,
        },
        remote: {
          type: "remote",
          url: "https://mcp.example.test/tools",
          headers: { "x-test": "remote-secret" },
          oauth: false,
        },
        local: {
          type: "local",
          command: ["node", "probe.mjs"],
          environment: { PROBE: "표식" },
          cwd: join(root, "mcp"),
        },
      },
    });
    expect(config.agent).toBeUndefined();
    expect(readFileSync(instructionPath, "utf8")).toBe(systemPrompt);
    expect(statSync(sessionDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(instructionPath).mode & 0o777).toBe(0o600);
    expect(statSync(prepared.configPath).mode & 0o777).toBe(0o600);
    expect(prepared.processEnv).toMatchObject({
      PWD: join(root, "workspace"),
      OPENCODE_CONFIG: prepared.configPath,
      XDG_CONFIG_HOME: join(sessionDirectory, "xdg", "config"),
      XDG_DATA_HOME: join(sessionDirectory, "xdg", "data"),
      XDG_CACHE_HOME: join(sessionDirectory, "xdg", "cache"),
      XDG_STATE_HOME: join(sessionDirectory, "xdg", "state"),
    });
    expect(prepared.processEnv.OPENCODE_API_KEY).toBeUndefined();
    expect(prepared.processEnv.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("reuses the existing instructions file on a resume without a full prompt reinjection", async () => {
    const sessionDirectory = makeTempDirSync("opencode-resume-config-");
    const common = {
      workspaceDir: "/workspace",
      model: "opencode/deepseek-v4.1-flash-free",
      sessionDirectory,
      agentSessionId: "session-resume-398",
      processEnv: {},
    };
    const first = await prepareOpenCodeSession({ ...common, systemPrompt: "retained instructions" });
    const resumed = await prepareOpenCodeSession(common);
    const config = JSON.parse(readFileSync(resumed.configPath, "utf8")) as { instructions?: string[] };

    expect(config.instructions).toEqual([join(sessionDirectory, "opencode", "system-prompt.md")]);
    expect(readFileSync(first.instructionPath!, "utf8")).toBe("retained instructions");
    expect(readFileSync(resumed.instructionPath!, "utf8")).toBe("retained instructions");
  });

  it("omits MCP config when this turn disables MCP", async () => {
    const prepared = await prepareOpenCodeSession({
      workspaceDir: "/workspace",
      model: "opencode/deepseek-v4.1-flash-free",
      sessionDirectory: makeTempDirSync("opencode-no-mcp-"),
      agentSessionId: "session-no-mcp-398",
      systemPrompt: "",
      useMcp: false,
      resolvedMcpServers: [{ type: "streamable_http", name: "remote", url: "https://mcp.example.test" }],
      processEnv: {},
    });
    const config = JSON.parse(readFileSync(prepared.configPath, "utf8")) as Record<string, unknown>;
    expect(config.mcp).toBeUndefined();
  });

  it("applies the example allowlist in order and omits explicitly empty MCP servers", async () => {
    const example = readFileSync(join(process.cwd(), "config/model-catalog.yaml.example"), "utf8");
    const preset = parseModelCatalogYaml(example).presets.find(
      (entry) => entry.id === "opencode-deepseek-v4.1-flash-free",
    );
    const allowlist = preset?.mcp_tool_allowlist?.roselin;
    const soulstreamTools = allowlist?.soulstream;
    expect(soulstreamTools).toHaveLength(55);
    expect(allowlist?.serendipity).toEqual([]);

    const prepared = await prepareOpenCodeSession({
      workspaceDir: "/workspace",
      model: "opencode/deepseek-v4.1-flash-free",
      sessionDirectory: makeTempDirSync("opencode-allowlist-"),
      agentSessionId: "session-allowlist-398",
      useMcp: true,
      internalMcpUrl: "http://127.0.0.1:4206/mcp",
      opencodeMcpToolAllowlist: allowlist,
      resolvedMcpServers: [
        { type: "streamable_http", name: "soulstream", url: "https://obsolete.example/mcp", headers: { Authorization: "header-secret" } },
        { type: "streamable_http", name: "serendipity", headers: { Authorization: "must-not-be-read" } },
        { type: "streamable_http", name: "exa", url: "https://exa.example/mcp" },
        { type: "stdio", name: "atom", command: "node", args: ["atom.mjs"] },
      ],
      processEnv: {},
    });
    const config = JSON.parse(readFileSync(prepared.configPath, "utf8")) as {
      mcp?: Record<string, unknown>;
      permission?: Record<string, string>;
    };
    const expectedPermissionKeys = [
      "*", "question", "plan_exit", "soulstream_*",
      ...soulstreamTools!.map((name) => `soulstream_${name}`),
    ];

    expect(new Set(soulstreamTools).size).toBe(55);
    expect(config.permission && Object.keys(config.permission)).toEqual(expectedPermissionKeys);
    expect(config.permission).toMatchObject({
      "*": "allow",
      question: "deny",
      plan_exit: "deny",
      "soulstream_*": "deny",
      soulstream_get_session_name: "allow",
      soulstream_reflect_cluster_brief: "allow",
    });
    expect(soulstreamTools!.every((name) => config.permission?.[`soulstream_${name}`] === "allow")).toBe(true);
    expect(config.mcp).toMatchObject({ soulstream: { type: "remote" }, exa: { type: "remote" }, atom: { type: "local" } });
    expect(config.mcp).not.toHaveProperty("serendipity");
    expect(config).not.toHaveProperty("tools");
  });
});
