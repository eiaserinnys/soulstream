import type { NodeRegister } from "@soulstream/wire-schema";

export interface RegistrationParams {
  nodeId: string;
  host: string;
  port: number;
  userName: string;
}

/**
 * node_register payload 조립. wire-schema NodeRegister 타입 정본 사용.
 *
 * Phase B-1: max_concurrent=0 (세션 실행 능력 0). supported_backends=["codex"] (옵션 D 비대칭 단계 1).
 *
 * Phase B-2 (R6): 임시 *codex-default* agent 1개 광고 — orch가 backend=codex 라우팅 대상으로
 * 본 노드를 선택 가능 (Phase A 라우팅과 정합). 실제 agent_registry yaml 정본은 B-3에서.
 */
export function buildRegistrationMsg(params: RegistrationParams): NodeRegister {
  const msg: NodeRegister = {
    type: "node_register",
    node_id: params.nodeId,
    host: params.host,
    port: params.port,
    capabilities: { max_concurrent: 0 },
    supported_backends: ["codex"],
    agents: [
      {
        id: "codex-default",
        name: "Codex Default",
        backend: "codex",
      },
    ],
  };
  if (params.userName) {
    msg.user = {
      name: params.userName,
      hasPortrait: false,
    };
  }
  return msg;
}
