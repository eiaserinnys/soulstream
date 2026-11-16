/**
 * 세션 에이전트 프로필의 금지 도구를 서버 쪽 MCP 거름으로 옮긴다.
 *
 * `disallowed_tools`는 지금까지 클라이언트 엔진 인자(`mcp__<서버>__<도구>`)로만
 * 전달됐다. 세션 자격 증명(ssf1/ssr1)에는 세션 ID가 있으므로 서버도 같은 목록을
 * 적용한다. 여기서는 소울스트림 내부 MCP 서버(soulstream 계열)의 도구만 맨 이름으로
 * 해석한다. Bash 같은 내장 도구와 다른 MCP 서버 항목은 다른 표면이 이미 다룬다.
 */
import type { AgentProfile } from "../agent_registry.js";
import { isSoulstreamMcpServerName } from "../engine/soulstream_internal_mcp.js";
import type { McpRuntime } from "./runtime.js";

const MCP_TOOL_PREFIX = "mcp__";
const SERVER_TOOL_SEPARATOR = "__";

/** `mcp__<서버>__<도구>` 가운데 서버가 소울스트림 내부 MCP일 때 도구 맨 이름을 돌려준다. */
export function soulstreamToolName(entry: string): string | undefined {
  const trimmed = entry.trim();
  if (!trimmed.startsWith(MCP_TOOL_PREFIX)) return undefined;
  const rest = trimmed.slice(MCP_TOOL_PREFIX.length);
  const separator = rest.indexOf(SERVER_TOOL_SEPARATOR);
  if (separator <= 0) return undefined;
  const serverName = rest.slice(0, separator).trim();
  const toolName = rest.slice(separator + SERVER_TOOL_SEPARATOR.length).trim();
  if (!toolName || !isSoulstreamMcpServerName(serverName)) return undefined;
  return toolName;
}

/** 프로필의 `disallowed_tools`에서 소울스트림 내부 MCP 도구의 맨 이름만 모은다. */
export function disallowedSoulstreamTools(profile: AgentProfile): ReadonlySet<string> {
  const names = new Set<string>();
  for (const entry of profile.disallowed_tools ?? []) {
    const name = soulstreamToolName(entry);
    if (name) names.add(name);
  }
  return names;
}

/**
 * 세션의 에이전트 프로필을 찾는다.
 *
 * 이 노드의 실행 중 task 기록(profileId, agentProfileSnapshot)을 먼저 쓰고,
 * 없으면 세션 데이터의 `agent_id`와 agent registry로 찾는다. 조회 실패는
 * 프로필 없음으로 본다 — 도구 거름은 보안 경계가 아니라 프로필 반영이다.
 */
export async function findSessionAgentProfile(
  runtime: Pick<McpRuntime, "taskManager" | "db" | "agentRegistry">,
  sessionId: string,
): Promise<AgentProfile | undefined> {
  const task = runtime.taskManager.getTask(sessionId);
  if (task) {
    const fromTask = task.agentProfileSnapshot
      ?? (task.profileId ? runtime.agentRegistry.get(task.profileId) : undefined);
    if (fromTask) return fromTask;
  }

  let agentId: string | null | undefined;
  try {
    agentId = (await runtime.db.getSession(sessionId))?.agent_id;
  } catch {
    return undefined;
  }
  if (!agentId) return undefined;
  return runtime.agentRegistry.get(agentId);
}
