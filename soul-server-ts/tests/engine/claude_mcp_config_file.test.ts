import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { externalizeClaudeMcpConfig } from "../../src/engine/claude_mcp_config_file.js";

const roots: string[] = [];
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "claude-mcp-config-test-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const MCP_CONFIG_JSON = JSON.stringify({
  mcpServers: {
    atom: {
      type: "http",
      url: "http://127.0.0.1:1/mcp",
      headers: { Authorization: "Bearer test-secret-value" },
    },
  },
});

describe("externalizeClaudeMcpConfig", () => {
  it("writes the JSON to a 0600 file in the given directory and swaps the argument", () => {
    const directory = join(makeRoot(), "session");
    const args = ["--print", "--mcp-config", MCP_CONFIG_JSON, "--verbose"];
    const result = externalizeClaudeMcpConfig(args, directory);

    expect(result.args).toHaveLength(args.length);
    expect(result.args[0]).toBe("--print");
    expect(result.args[3]).toBe("--verbose");
    const file = result.args[2]!;
    expect(file).not.toBe(MCP_CONFIG_JSON);
    expect(dirname(file)).toBe(directory);
    expect(basename(file).startsWith("claude-mcp-config-")).toBe(true);
    expect(basename(file).endsWith(".json")).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(MCP_CONFIG_JSON);
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(directory).mode & 0o777).toBe(0o700);
    }

    result.cleanup();
  });

  it("removes the file on cleanup and tolerates repeated cleanup", () => {
    const directory = join(makeRoot(), "session");
    const result = externalizeClaudeMcpConfig(["--mcp-config", MCP_CONFIG_JSON], directory);
    const file = result.args[1]!;

    expect(existsSync(file)).toBe(true);
    result.cleanup();
    expect(existsSync(file)).toBe(false);
    expect(() => result.cleanup()).not.toThrow();
  });

  it("leaves args untouched and writes nothing when no inline mcp config is present", () => {
    const directory = join(makeRoot(), "session");
    const withoutFlag = ["--print", "--verbose"];
    const withoutFlagResult = externalizeClaudeMcpConfig(withoutFlag, directory);
    expect(withoutFlagResult.args).toEqual(withoutFlag);
    expect(existsSync(directory)).toBe(false);
    withoutFlagResult.cleanup();

    const notJson = ["--print", "--mcp-config", "mcp.json"];
    const notJsonResult = externalizeClaudeMcpConfig(notJson, directory);
    expect(notJsonResult.args).toEqual(notJson);
    expect(existsSync(directory)).toBe(false);
    notJsonResult.cleanup();
  });

  it("uses a temporary directory under os.tmpdir() and removes it on cleanup", () => {
    const result = externalizeClaudeMcpConfig(["--mcp-config", MCP_CONFIG_JSON], undefined);
    const file = result.args[1]!;
    const directory = dirname(file);

    expect(dirname(directory)).toBe(tmpdir());
    expect(basename(directory).startsWith("soulstream-claude-mcp-")).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(MCP_CONFIG_JSON);

    result.cleanup();
    expect(existsSync(directory)).toBe(false);
  });
});
