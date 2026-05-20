import type { AgentBackend, AgentProfile } from "./agent_registry.js";

/**
 * soul-server-ts가 현재 실제로 실행 가능한 engine backend 목록.
 *
 * registry는 마이그레이션 준비를 위해 Claude profile을 읽을 수 있지만, ClaudeEngineAdapter가
 * 들어오기 전까지 node_register/MCP/create 경로는 codex만 광고·실행한다.
 */
export const EXECUTABLE_BACKENDS = ["codex"] as const satisfies readonly AgentBackend[];

export function isExecutableBackend(
  backend: AgentBackend,
  executableBackends: readonly AgentBackend[] = EXECUTABLE_BACKENDS,
): boolean {
  return executableBackends.includes(backend);
}

export function unsupportedBackendMessage(agent: AgentProfile): string {
  return (
    `Unsupported backend "${agent.backend}" for agent "${agent.id}" ` +
    "in soul-server-ts: engine support is not enabled"
  );
}
