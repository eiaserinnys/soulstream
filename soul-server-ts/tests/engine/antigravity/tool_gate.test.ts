import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ANTIGRAVITY_TOOL_GATE_SOURCE,
  computeAntigravityToolPolicy,
  type AntigravityGatePolicy,
} from "../../../src/engine/antigravity/tool_policy.js";
import { makeTempDirSync } from "../../helpers/temp_dir.js";
import {
  UTONIUM_ALLOWED,
  UTONIUM_DENIED,
  UTONIUM_SEAL_SCRIPTS,
} from "./utonium_policy_fixture.js";

const workspace = makeTempDirSync("agy-gate-workspace-");

function gatePolicy(overrides: Partial<{ allowed: string[]; denied: string[]; agentId: string }> = {}) {
  return computeAntigravityToolPolicy({
    allowedTools: overrides.allowed ?? [
      "Read",
      "Agent",
      "SendMessage",
      `Bash(python3 ${UTONIUM_SEAL_SCRIPTS}/seal.py spec:*)`,
      `Bash(python3 ${UTONIUM_SEAL_SCRIPTS}/haniel_approve.py:*)`,
      `Write(//${workspace.slice(1)}/**)`,
      `Edit(//${workspace.slice(1)}/**)`,
      "mcp__soulstream__get_card",
      "mcp__soulstream__update_card_now",
      "mcp__soulstream__create_agent_session",
      "mcp__atom__compile_subtree",
    ],
    disallowedTools: overrides.denied ?? UTONIUM_DENIED,
    agentId: overrides.agentId ?? "utonium",
  });
}

function installGate(policy: AntigravityGatePolicy) {
  const directory = makeTempDirSync("agy-gate-");
  const policyPath = join(directory, "policy.json");
  const gatePath = join(directory, "tool-gate.cjs");
  writeFileSync(policyPath, JSON.stringify(policy));
  writeFileSync(gatePath, ANTIGRAVITY_TOOL_GATE_SOURCE);
  return { directory, policyPath, gatePath };
}

function runGate(gatePath: string, policyPath: string, stdin: string) {
  return new Promise<{ code: number | null; decision?: string; reason?: string; raw: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [gatePath, policyPath], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => {
      let parsed: { decision?: string; reason?: string } = {};
      try { parsed = JSON.parse(stdout); } catch {
        reject(new Error(`gate produced no JSON: code=${code} stdout=${stdout} stderr=${stderr}`));
        return;
      }
      resolve({ code, raw: stdout, ...parsed });
    });
    child.stdin.end(stdin);
  });
}

const hook = (name: string, args: Record<string, unknown>) => JSON.stringify({ toolCall: { name, args } });

describe("Antigravity PreToolUse tool gate", () => {
  it("allows writes inside the unit folder and denies escaping paths", async () => {
    const { gatePath, policyPath } = installGate(gatePolicy().gate);

    await expect(runGate(gatePath, policyPath, hook("write_file", { Path: join(workspace, "inside.txt") })))
      .resolves.toMatchObject({ code: 0, decision: "allow" });
    await expect(runGate(gatePath, policyPath, hook("edit_file", { Path: join(workspace, "inside.txt") })))
      .resolves.toMatchObject({ code: 0, decision: "allow" });
    await expect(runGate(gatePath, policyPath, hook("write_file", { Path: join(workspace, "..", "outside.txt") })))
      .resolves.toMatchObject({ code: 0, decision: "deny" });
    await expect(runGate(gatePath, policyPath, hook("edit_file", { TargetFile: "/etc/passwd" })))
      .resolves.toMatchObject({ code: 0, decision: "deny" });

    const utonium = installGate(gatePolicy({ allowed: UTONIUM_ALLOWED, agentId: "utonium" }).gate);
    await expect(runGate(utonium.gatePath, utonium.policyPath, hook("write_file", {
      Path: "/home/eias/workspace/.local/tmp/../x",
    }))).resolves.toMatchObject({ code: 0, decision: "deny" });
  });

  it("allows exactly the permitted commands and rejects metacharacters", async () => {
    const { gatePath, policyPath } = installGate(gatePolicy().gate);
    const seal = `python3 ${UTONIUM_SEAL_SCRIPTS}/seal.py spec`;

    await expect(runGate(gatePath, policyPath, hook("run_command", { CommandLine: seal })))
      .resolves.toMatchObject({ code: 0, decision: "allow" });
    await expect(runGate(gatePath, policyPath, hook("run_command", { CommandLine: `${seal} --spec /tmp/spec.yaml` })))
      .resolves.toMatchObject({ code: 0, decision: "allow" });
    await expect(runGate(gatePath, policyPath, hook("run_command", { CommandLine: `${seal} && rm x` })))
      .resolves.toMatchObject({ code: 0, decision: "deny" });
    await expect(runGate(gatePath, policyPath, hook("run_command", { CommandLine: "grep -r x ." })))
      .resolves.toMatchObject({ code: 0, decision: "deny" });
  });

  it("decides MCP tools by the allow and deny patterns, including gateway names", async () => {
    const { gatePath, policyPath } = installGate(gatePolicy().gate);

    await expect(runGate(gatePath, policyPath, hook("call_mcp_tool", {
      ServerName: "soulstream", ToolName: "get_card", Arguments: {},
    }))).resolves.toMatchObject({ code: 0, decision: "allow" });
    await expect(runGate(gatePath, policyPath, hook("call_mcp_tool", {
      ServerName: "soulstream", ToolName: "delete_session", Arguments: {},
    }))).resolves.toMatchObject({ code: 0, decision: "deny" });
    await expect(runGate(gatePath, policyPath, hook("call_mcp_tool", {
      ServerName: "profile-utonium", ToolName: "atom__compile_subtree", Arguments: {},
    }))).resolves.toMatchObject({ code: 0, decision: "allow" });
    await expect(runGate(gatePath, policyPath, hook("call_mcp_tool", {
      ServerName: "atom", ToolName: "update_card", Arguments: {},
    }))).resolves.toMatchObject({ code: 0, decision: "deny" });
    await expect(runGate(gatePath, policyPath, hook("call_mcp_tool", {
      ServerName: "atom", ToolName: "compile_subtree", Arguments: {},
    }))).resolves.toMatchObject({ code: 0, decision: "allow" });
  });

  it("allows other tools and denies unreadable input", async () => {
    const { gatePath, policyPath } = installGate(gatePolicy().gate);

    await expect(runGate(gatePath, policyPath, hook("read_file", { Path: "/etc/hosts" })))
      .resolves.toMatchObject({ code: 0, decision: "allow" });
    await expect(runGate(gatePath, policyPath, "{not json"))
      .resolves.toMatchObject({ code: 0, decision: "deny" });
    await expect(runGate(gatePath, policyPath, JSON.stringify({ toolCall: null })))
      .resolves.toMatchObject({ code: 0, decision: "deny" });
  });
});
