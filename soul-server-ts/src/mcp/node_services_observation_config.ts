import type {
  NodeServicesObservationConfig,
  NodeServicesObservationEndpointConfig,
} from "./runtime.js";

export interface NodeServicesObservationEnv {
  HANIEL_DASHBOARD_URL?: string | undefined;
  HANIEL_DASHBOARD_TOKEN_FILE?: string | undefined;
  HANIEL_ORCH_URL?: string | undefined;
  HANIEL_ORCH_TOKEN_FILE?: string | undefined;
}

/**
 * Haniel 관측 MCP의 노드 설정. 짝마다 둘 다 있을 때만 엔드포인트가 되고,
 * 하나도 없으면 도구는 NOT_CONFIGURED다. 값(토큰 경로 원문)은 로그에 남기지 않는다.
 * 스위치와 무관하게 full 세션에도 적용된다.
 */
export function resolveNodeServicesObservation(
  env: NodeServicesObservationEnv,
): NodeServicesObservationConfig | undefined {
  const dashboard = endpointPair(env.HANIEL_DASHBOARD_URL, env.HANIEL_DASHBOARD_TOKEN_FILE);
  const orch = endpointPair(env.HANIEL_ORCH_URL, env.HANIEL_ORCH_TOKEN_FILE);
  if (!dashboard && !orch) return undefined;
  return {
    ...(dashboard ? { dashboard } : {}),
    ...(orch ? { orch } : {}),
  };
}

function endpointPair(
  baseUrl: string | undefined,
  tokenFile: string | undefined,
): NodeServicesObservationEndpointConfig | undefined {
  if (!baseUrl || !tokenFile) return undefined;
  return { baseUrl, tokenFile };
}
