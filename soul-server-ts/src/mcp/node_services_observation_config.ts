import type {
  NodeServicesObservationConfig,
  NodeServicesObservationEndpointConfig,
} from "./runtime.js";

export interface NodeServicesObservationEnv {
  HANIEL_DASHBOARD_URL?: string | undefined;
  HANIEL_DASHBOARD_TOKEN_FILE?: string | undefined;
  HANIEL_ORCH_URL?: string | undefined;
  HANIEL_ORCH_TOKEN_FILE?: string | undefined;
  HANIEL_ORCH_VAULT_ENV_FILE?: string | undefined;
}

/**
 * Haniel 관측 MCP의 노드 설정. dashboard는 URL+토큰 파일 짝이고,
 * orch는 URL에 토큰 파일과 볼트 env 파일 중 정확히 하나를 받는다.
 * 하나도 없으면 도구는 NOT_CONFIGURED다. 값(경로 원문)은 로그에 남기지 않는다.
 * 스위치와 무관하게 full 세션에도 적용된다.
 */
export function resolveNodeServicesObservation(
  env: NodeServicesObservationEnv,
): NodeServicesObservationConfig | undefined {
  const dashboard = endpointPair(env.HANIEL_DASHBOARD_URL, env.HANIEL_DASHBOARD_TOKEN_FILE);
  const orch = orchEndpointPair(
    env.HANIEL_ORCH_URL,
    env.HANIEL_ORCH_TOKEN_FILE,
    env.HANIEL_ORCH_VAULT_ENV_FILE,
  );
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

function orchEndpointPair(
  baseUrl: string | undefined,
  tokenFile: string | undefined,
  vaultEnvFile: string | undefined,
): NodeServicesObservationEndpointConfig | undefined {
  if (!baseUrl) return undefined;
  if (tokenFile && !vaultEnvFile) return { baseUrl, tokenFile };
  if (vaultEnvFile && !tokenFile) return { baseUrl, vaultEnvFile };
  return undefined;
}
