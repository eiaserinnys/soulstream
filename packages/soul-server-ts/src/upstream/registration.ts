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
 * B-1 노드는 세션 실행 능력 0이므로 max_concurrent=0, agents=[] 광고.
 * supported_backends=["codex"]로 옵션 D 비대칭 모델 단계 1 식별 (위임 §R3).
 */
export function buildRegistrationMsg(params: RegistrationParams): NodeRegister {
  const msg: NodeRegister = {
    type: "node_register",
    node_id: params.nodeId,
    host: params.host,
    port: params.port,
    capabilities: { max_concurrent: 0 },
    supported_backends: ["codex"],
    agents: [],
  };
  if (params.userName) {
    msg.user = {
      name: params.userName,
      hasPortrait: false,
    };
  }
  return msg;
}
