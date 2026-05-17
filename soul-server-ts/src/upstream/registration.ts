import type { NodeRegister } from "@soulstream/wire-schema";

import type { AgentRegistry } from "../agent_registry.js";

export interface RegistrationParams {
  nodeId: string;
  host: string;
  port: number;
  userName: string;
  agentRegistry: AgentRegistry;
}

/**
 * node_register payload 조립. wire-schema NodeRegister 타입 정본 사용.
 *
 * Phase B-3 (R3): agents·supported_backends·max_concurrent를 *agentRegistry yaml*에서 동적으로
 * 채운다. B-2의 하드코드 `codex-default` 광고는 제거.
 *
 * - max_concurrent = agents.length (각 agent 동시 1 turn 모델 — Codex 단일턴)
 * - supported_backends = registry의 중복 제거 backend 목록
 * - agents = registry.list() 매핑 (id, name, backend만 — portrait는 후속)
 *
 * 빈 registry → agents=[], supported_backends=[], max_concurrent=0. orch는 본 노드로 라우팅 안 함.
 */
export function buildRegistrationMsg(params: RegistrationParams): NodeRegister {
  const agents = params.agentRegistry.list();
  const msg: NodeRegister = {
    type: "node_register",
    node_id: params.nodeId,
    host: params.host,
    port: params.port,
    capabilities: { max_concurrent: agents.length },
    supported_backends: params.agentRegistry.supportedBackends(),
    agents: agents.map((a) => ({
      id: a.id,
      name: a.name,
      backend: a.backend,
    })),
  };
  if (params.userName) {
    msg.user = {
      name: params.userName,
      hasPortrait: false,
    };
  }
  return msg;
}
