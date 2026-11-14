import {
  ANTIGRAVITY_GATEWAY_TOOL_SEPARATOR,
  antigravityGatewayServerName,
} from "./mcp_gateway.js";

/**
 * dontAsk 프로필의 Claude 도구 정책을 agy 정의 `tools`와 PreToolUse 게이트로 옮긴다.
 * 대응표와 판정 규칙의 정본은 card1362 설계 §1·§2다.
 */

/** 제한 모드 정의 `tools`의 정규 순서. 설계 대응표 순서(Read, Write, Edit, Bash, ...)를 따른다. */
export const ANTIGRAVITY_RESTRICTED_TOOL_ORDER = [
  "view_file",
  "write_to_file",
  "replace_file_content",
  "multi_replace_file_content",
  "run_command",
  "invoke_subagent",
  "wait",
  "send_message",
  "find_by_name",
  "list_dir",
  "grep_search",
  "read_url_content",
  "search_web",
  "notebook_edit",
  "ask_question",
  "finish",
] as const;

/** Claude 내장 도구 이름 → agy 정의 도구 이름. */
const DEFINITION_TOOLS_BY_CLAUDE_NAME: Record<string, readonly string[]> = {
  Read: ["view_file"],
  Write: ["write_to_file"],
  Edit: ["replace_file_content", "multi_replace_file_content"],
  Bash: ["run_command"],
  Agent: ["invoke_subagent", "wait"],
  SendMessage: ["send_message"],
  Glob: ["find_by_name", "list_dir"],
  Grep: ["grep_search"],
  WebFetch: ["read_url_content"],
  WebSearch: ["search_web"],
  NotebookEdit: ["notebook_edit"],
  AskUserQuestion: ["ask_question"],
};

export interface AntigravityGatePathRule {
  path: string;
  subtree: boolean;
}

export interface AntigravityGatePathPolicy {
  all: boolean;
  paths: AntigravityGatePathRule[];
}

export interface AntigravityGateCommandPolicy {
  all: boolean;
  exact: string[];
  prefixes: string[];
}

export interface AntigravityGateMcpPolicy {
  allow: string[];
  deny: string[];
  gatewayServer: string;
  toolSeparator: string;
}

export interface AntigravityGatePolicy {
  write: AntigravityGatePathPolicy;
  edit: AntigravityGatePathPolicy;
  command: AntigravityGateCommandPolicy;
  mcp: AntigravityGateMcpPolicy;
}

export interface AntigravityToolPolicy {
  definitionTools: string[];
  gate: AntigravityGatePolicy;
}

export interface AntigravityToolPolicyInput {
  allowedTools: readonly string[];
  disallowedTools?: readonly string[];
  agentId: string;
}

export function computeAntigravityToolPolicy(input: AntigravityToolPolicyInput): AntigravityToolPolicy {
  const allowed = new Set<string>(["finish"]);
  const write: AntigravityGatePathPolicy = { all: false, paths: [] };
  const edit: AntigravityGatePathPolicy = { all: false, paths: [] };
  const command: AntigravityGateCommandPolicy = { all: false, exact: [], prefixes: [] };
  const mcp: AntigravityGateMcpPolicy = {
    allow: [],
    deny: [],
    gatewayServer: antigravityGatewayServerName(input.agentId),
    toolSeparator: ANTIGRAVITY_GATEWAY_TOOL_SEPARATOR,
  };

  for (const item of input.allowedTools) {
    if (item.startsWith("mcp__")) {
      mcp.allow.push(item);
      continue;
    }
    const parsed = parseClaudeToolItem(item);
    if (!parsed) continue;
    if (parsed.name === "Write") {
      addDefinitionTools(allowed, parsed.name);
      if (parsed.parameter === undefined) write.all = true;
      else addPathRule(write, parsed.parameter);
      continue;
    }
    if (parsed.name === "Edit") {
      addDefinitionTools(allowed, parsed.name);
      if (parsed.parameter === undefined) edit.all = true;
      else addPathRule(edit, parsed.parameter);
      continue;
    }
    if (parsed.name === "Bash") {
      addDefinitionTools(allowed, parsed.name);
      if (parsed.parameter === undefined) command.all = true;
      else if (parsed.parameter.endsWith(":*")) command.prefixes.push(parsed.parameter.slice(0, -2));
      else command.exact.push(parsed.parameter);
      continue;
    }
    addDefinitionTools(allowed, parsed.name);
  }

  const denied = new Set<string>();
  for (const item of input.disallowedTools ?? []) {
    if (item.startsWith("mcp__")) {
      mcp.deny.push(item);
      continue;
    }
    const base = item.split("(")[0] ?? item;
    for (const name of DEFINITION_TOOLS_BY_CLAUDE_NAME[base] ?? []) denied.add(name);
  }

  const definitionTools = ANTIGRAVITY_RESTRICTED_TOOL_ORDER
    .filter(name => allowed.has(name) && !denied.has(name));
  // finish는 언제나 넣는다.
  if (!definitionTools.includes("finish")) definitionTools.push("finish");

  return { definitionTools: [...definitionTools], gate: { write, edit, command, mcp } };
}

/**
 * Claude 하위 에이전트 정의의 `tools` 목록을 agy 하위 정의 도구로 옮긴다.
 * 대응표 순서로 옮긴 뒤 `send_message`, `finish`를 더한다(설계 §3).
 */
export function antigravitySubagentTools(tools: readonly string[]): string[] {
  const mapped = new Set<string>();
  for (const item of tools) addDefinitionTools(mapped, item.trim());
  const names = ANTIGRAVITY_RESTRICTED_TOOL_ORDER
    .filter(name => name !== "send_message" && name !== "finish" && mapped.has(name));
  names.push("send_message", "finish");
  return names;
}

function addDefinitionTools(target: Set<string>, claudeName: string): void {
  for (const name of DEFINITION_TOOLS_BY_CLAUDE_NAME[claudeName] ?? []) target.add(name);
}

function parseClaudeToolItem(item: string): { name: string; parameter?: string } | undefined {
  const open = item.indexOf("(");
  if (open < 0) return { name: item.trim() };
  if (!item.endsWith(")")) return undefined;
  return { name: item.slice(0, open).trim(), parameter: item.slice(open + 1, -1) };
}

function addPathRule(policy: AntigravityGatePathPolicy, parameter: string): void {
  // `//`로 시작하는 값만 절대 경로 `/…`로 읽는다. 상대 경로 등은 버린다.
  if (!parameter.startsWith("//")) return;
  const absolute = parameter.slice(1);
  if (absolute.endsWith("/**")) policy.paths.push({ path: absolute.slice(0, -3), subtree: true });
  else policy.paths.push({ path: absolute, subtree: false });
}

/**
 * PreToolUse 훅이 부르는 자기완결 게이트 소스(node 내장 모듈만 사용).
 * 운영은 tsup 번들이라 별도 진입 파일을 둘 수 없어 이 문자열을 세션 상태 폴더에 쓴다.
 */
export const ANTIGRAVITY_TOOL_GATE_SOURCE = `"use strict";
const fs = require("node:fs");
const path = require("node:path");

function allow() {
  process.stdout.write(JSON.stringify({ decision: "allow" }));
  process.exit(0);
}
function deny(reason) {
  process.stdout.write(JSON.stringify({ decision: "deny", reason: reason }));
  process.exit(0);
}

let policy;
try {
  policy = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
} catch (error) {
  deny("policy unreadable");
}

let input;
try {
  input = JSON.parse(fs.readFileSync(0, "utf8"));
} catch (error) {
  deny("invalid hook stdin");
}
const toolCall = input && typeof input === "object" ? input.toolCall : undefined;
if (!toolCall || typeof toolCall !== "object" || typeof toolCall.name !== "string") {
  deny("invalid hook stdin");
}
const name = toolCall.name;
const args = toolCall.args && typeof toolCall.args === "object" ? toolCall.args : {};

const WRITE_TOOLS = ["write_file", "write_to_file"];
const EDIT_TOOLS = ["edit_file", "replace_file_content", "multi_replace_file_content", "notebook_edit"];

function pathAllowed(family, value) {
  if (typeof value !== "string" || value === "") return false;
  if (family.all) return true;
  const target = path.resolve(value);
  for (const rule of family.paths) {
    const root = path.resolve(rule.path);
    if (rule.subtree) {
      if (target === root || target.startsWith(root + path.sep)) return true;
    } else if (target === root) {
      return true;
    }
  }
  return false;
}

function unsafeShell(command) {
  const characters = [";", "&", "|", "\\u0060", ">", "<", "\\n", "\\r"];
  for (const character of characters) {
    if (command.indexOf(character) >= 0) return true;
  }
  return command.indexOf("$(") >= 0;
}

function wildcard(pattern, value) {
  const parts = pattern.split("*");
  if (parts.length === 1) return value === pattern;
  if (!value.startsWith(parts[0])) return false;
  let index = parts[0].length;
  for (let i = 1; i < parts.length - 1; i += 1) {
    const at = value.indexOf(parts[i], index);
    if (at < 0) return false;
    index = at + parts[i].length;
  }
  const last = parts[parts.length - 1];
  return value.length >= index + last.length && value.endsWith(last);
}

if (WRITE_TOOLS.indexOf(name) >= 0 || EDIT_TOOLS.indexOf(name) >= 0) {
  const family = WRITE_TOOLS.indexOf(name) >= 0 ? policy.write : policy.edit;
  const value = args.Path !== undefined
    ? args.Path
    : (args.TargetFile !== undefined ? args.TargetFile : args.AbsolutePath);
  if (pathAllowed(family, value)) allow();
  deny("path not allowed");
}

if (name === "run_command") {
  const command = typeof args.CommandLine === "string" ? args.CommandLine.trim() : "";
  if (command === "") deny("missing command");
  if (policy.command.all) allow();
  if (unsafeShell(command)) deny("shell metacharacters are not allowed");
  if (policy.command.exact.indexOf(command) >= 0) allow();
  for (const prefix of policy.command.prefixes) {
    if (command === prefix || command.startsWith(prefix + " ")) allow();
  }
  deny("command not allowed");
}

if (name === "call_mcp_tool") {
  const separator = policy.mcp.toolSeparator;
  let server = typeof args.ServerName === "string" ? args.ServerName : "";
  let tool = typeof args.ToolName === "string" ? args.ToolName : "";
  if (server === policy.mcp.gatewayServer && tool.indexOf(separator) > 0) {
    const index = tool.indexOf(separator);
    server = tool.slice(0, index);
    tool = tool.slice(index + separator.length);
  }
  const target = "mcp__" + server + separator + tool;
  for (const pattern of policy.mcp.deny) {
    if (wildcard(pattern, target)) deny("mcp tool denied");
  }
  for (const pattern of policy.mcp.allow) {
    if (wildcard(pattern, target)) allow();
  }
  deny("mcp tool not allowed");
}

allow();
`;
