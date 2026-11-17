/**
 * 세션 에이전트 프로필의 금지 도구를 서버 쪽 MCP 거름으로 옮긴다.
 *
 * `disallowed_tools`는 지금까지 클라이언트 엔진 인자(`mcp__<서버>__<도구>`)로만
 * 전달됐다. 세션 자격 증명(ssf1/ssr1)에는 세션 ID가 있으므로 서버도 같은 목록을
 * 적용한다. 여기서는 소울스트림 내부 MCP 서버(soulstream 계열)의 도구만 맨 이름으로
 * 해석한다. Bash 같은 내장 도구와 다른 MCP 서버 항목은 다른 표면이 이미 다룬다.
 *
 * 프로필 찾기는 세 갈래다.
 *
 * - 찾음: 프로필이 있다.
 * - 없음: 세션 행이 없거나, `agent_id`가 비었거나, registry에 그 에이전트가 없다.
 *   서비스 토큰이 아니면서 에이전트 없이 만든 세션 같은 정당한 상태이므로 거르지 않는다.
 * - 조회 실패: 세션 데이터 조회가 예외를 던졌다(연결 거부, 시간 초과, 5xx 등).
 *   짧게 다시 시도하고, 그래도 실패하면 호출부가 그 요청의 tools/call만 닫는다.
 *
 * 세션의 `agent_id`는 바뀌지 않으므로, 찾은 sessionId → agentId 대응은 프로세스 안에
 * 기억한다. 프로필 내용은 매번 registry에서 꺼내 프로필 수정이 곧바로 반영되게 한다.
 */
import type { AgentProfile } from "../agent_registry.js";
import { isSoulstreamMcpServerName } from "../engine/soulstream_internal_mcp.js";
import type { McpRuntime } from "./runtime.js";

const MCP_TOOL_PREFIX = "mcp__";
const SERVER_TOOL_SEPARATOR = "__";

/** 조회 실패 뒤 다시 시도하는 간격. 합쳐 600ms로 한 요청의 추가 지연은 1초 안쪽이다. */
export const DEFAULT_PROFILE_LOOKUP_RETRY_DELAYS_MS: readonly number[] = [200, 400];

/** 찾은 sessionId → agentId 기억의 기본 상한. 넘치면 가장 오래 쓴 항목부터 지운다. */
export const DEFAULT_AGENT_ID_CACHE_LIMIT = 5_000;

/** 조회 실패로 tools/call 하나를 닫을 때의 응답 문구. 세션 ID와 비밀값은 넣지 않는다. */
export const PROFILE_LOOKUP_UNAVAILABLE_MESSAGE =
  "세션 프로필을 잠시 확인할 수 없습니다. 잠시 후 다시 시도하세요.";

export type SessionProfileMissingReason = "no_session" | "no_agent_id" | "unknown_agent";

export type SessionProfileLookup =
  | { status: "found"; profile: AgentProfile }
  | { status: "missing"; reason: SessionProfileMissingReason }
  | { status: "unavailable"; attempts: number; reason: string };

export interface SessionProfileLookupOptions {
  /** 조회 실패 뒤 다시 시도하는 간격(ms). 기본 200ms·400ms. 시험 주입용. */
  retryDelaysMs?: readonly number[];
  /** 다시 시도 사이의 대기. 기본은 setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** 찾은 세션의 agent_id 기억. 없으면 매번 세션 데이터를 조회한다. */
  cache?: SessionAgentIdCache;
}

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
 * sessionId → agentId 기억.
 *
 * 세션의 `agent_id`는 바뀌지 않으므로 프로필 내용과 달리 오래 둘 수 있다. 최근에 쓴
 * 것을 남기는 상한(기본 5,000)을 두고 넘치면 가장 오래 쓴 항목을 지운다. 없음과
 * 조회 실패는 기억하지 않는다.
 */
export class SessionAgentIdCache {
  private readonly entries = new Map<string, string>();

  constructor(private readonly limit: number = DEFAULT_AGENT_ID_CACHE_LIMIT) {}

  get(sessionId: string): string | undefined {
    const agentId = this.entries.get(sessionId);
    if (agentId === undefined) return undefined;
    this.entries.delete(sessionId);
    this.entries.set(sessionId, agentId);
    return agentId;
  }

  set(sessionId: string, agentId: string): void {
    this.entries.delete(sessionId);
    this.entries.set(sessionId, agentId);
    if (this.entries.size <= this.limit) return;
    const oldest = this.entries.keys().next().value;
    if (oldest !== undefined) this.entries.delete(oldest);
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * 세션의 에이전트 프로필을 찾는다.
 *
 * 이 노드의 실행 중 task 기록(profileId, agentProfileSnapshot)을 먼저 쓰고, 없으면
 * 기억해 둔 agentId를, 그것도 없으면 세션 데이터의 `agent_id`와 agent registry로
 * 찾는다. 세션 데이터 조회가 예외를 던지면 `retryDelaysMs` 간격으로 다시 시도한다.
 */
export async function findSessionAgentProfile(
  runtime: Pick<McpRuntime, "taskManager" | "db" | "agentRegistry">,
  sessionId: string,
  options: SessionProfileLookupOptions = {},
): Promise<SessionProfileLookup> {
  const task = runtime.taskManager.getTask(sessionId);
  if (task) {
    const fromTask = task.agentProfileSnapshot
      ?? (task.profileId ? runtime.agentRegistry.get(task.profileId) : undefined);
    if (fromTask) return { status: "found", profile: fromTask };
  }

  const cachedAgentId = options.cache?.get(sessionId);
  if (cachedAgentId !== undefined) {
    const cachedProfile = runtime.agentRegistry.get(cachedAgentId);
    if (cachedProfile) return { status: "found", profile: cachedProfile };
    return { status: "missing", reason: "unknown_agent" };
  }

  const delays = options.retryDelaysMs ?? DEFAULT_PROFILE_LOOKUP_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? delay;
  let lastError: unknown;

  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    let session: { agent_id?: string | null } | null;
    try {
      session = await runtime.db.getSession(sessionId);
    } catch (error) {
      lastError = error;
      if (attempt >= delays.length) break;
      await sleep(delays[attempt]!);
      continue;
    }
    if (!session) return { status: "missing", reason: "no_session" };
    const agentId = typeof session.agent_id === "string" ? session.agent_id.trim() : "";
    if (!agentId) return { status: "missing", reason: "no_agent_id" };
    const profile = runtime.agentRegistry.get(agentId);
    if (!profile) return { status: "missing", reason: "unknown_agent" };
    options.cache?.set(sessionId, agentId);
    // 프로필 내용은 지금처럼 매번 registry에서 꺼낸다.
    return { status: "found", profile };
  }

  return {
    status: "unavailable",
    attempts: delays.length + 1,
    reason: errorReason(lastError),
  };
}

/**
 * 프로필 없음은 거르지 않지만, 기존 로그 줄은 그대로 두고 까닭을 담은 줄을 더한다.
 * (기존 줄의 모양은 #1955 시험이 정확히 대조한다.)
 */
export function logMissingSessionProfile(
  logger: Pick<McpRuntime["logger"], "warn">,
  sessionId: string,
  reason: SessionProfileMissingReason,
): void {
  logger.warn({ sessionId }, "MCP session has no agent profile; server-side tool filtering skipped");
  logger.warn({ sessionId, reason }, "MCP session agent profile missing");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorReason(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  const text = String(error ?? "");
  return text || "session_lookup_failed";
}
