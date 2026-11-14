import { describe, expect, it } from "vitest";
import {
  antigravitySubagentTools,
  computeAntigravityToolPolicy,
} from "../../../src/engine/antigravity/tool_policy.js";
import {
  UTONIUM_ALLOWED,
  UTONIUM_DENIED,
  UTONIUM_SEAL_SCRIPTS,
} from "./utonium_policy_fixture.js";

describe("Antigravity restricted tool policy", () => {
  it("computes utonium's definition tools from the allow and deny lists", () => {
    const policy = computeAntigravityToolPolicy({
      allowedTools: UTONIUM_ALLOWED,
      disallowedTools: UTONIUM_DENIED,
      agentId: "utonium",
    });

    expect(policy.definitionTools).toEqual([
      "view_file",
      "write_to_file",
      "replace_file_content",
      "multi_replace_file_content",
      "run_command",
      "invoke_subagent",
      "wait",
      "send_message",
      "finish",
    ]);
    expect(policy.definitionTools).not.toContain("grep_search");
    expect(policy.definitionTools).not.toContain("find_by_name");
    expect(policy.definitionTools).not.toContain("list_dir");
    expect(policy.definitionTools).not.toContain("define_subagent");
  });

  it("carries path, command, and MCP rules into the gate policy", () => {
    const policy = computeAntigravityToolPolicy({
      allowedTools: UTONIUM_ALLOWED,
      disallowedTools: UTONIUM_DENIED,
      agentId: "utonium",
    });

    expect(policy.gate.write).toEqual({
      all: false,
      paths: [{ path: "/home/eias/workspace/.local/tmp", subtree: true }],
    });
    expect(policy.gate.edit).toEqual({
      all: false,
      paths: [{ path: "/home/eias/workspace/.local/tmp", subtree: true }],
    });
    expect(policy.gate.command).toEqual({
      all: false,
      exact: [],
      prefixes: [
        `python3 ${UTONIUM_SEAL_SCRIPTS}/seal.py spec`,
        `python3 ${UTONIUM_SEAL_SCRIPTS}/haniel_approve.py`,
      ],
    });
    expect(policy.gate.mcp.gatewayServer).toBe("profile-utonium");
    expect(policy.gate.mcp.toolSeparator).toBe("__");
    expect(policy.gate.mcp.allow).toEqual([
      "mcp__soulstream__get_card",
      "mcp__soulstream__update_card_now",
      "mcp__soulstream__create_agent_session",
      "mcp__atom__compile_subtree",
    ]);
    expect(policy.gate.mcp.deny).toEqual([
      "mcp__soulstream__delete_session",
      "mcp__atom__update_card",
    ]);
  });

  it("lets a denied built-in win over the allow list", () => {
    const policy = computeAntigravityToolPolicy({
      allowedTools: ["Read", "Glob", "Grep", "Bash"],
      disallowedTools: ["Read", "Grep"],
      agentId: "denied",
    });

    expect(policy.definitionTools).toEqual(["run_command", "find_by_name", "list_dir", "finish"]);
  });

  it("maps a Claude eye definition's tools for a subagent", () => {
    expect(antigravitySubagentTools(["Read", "Grep", "Glob", "Bash"])).toEqual([
      "view_file",
      "run_command",
      "find_by_name",
      "list_dir",
      "grep_search",
      "send_message",
      "finish",
    ]);
  });
});
