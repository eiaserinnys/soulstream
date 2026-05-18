import { readFileSync } from "node:fs";

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
 * portrait 파일을 base64로 인코딩한다. Python `upstream/adapter.py:_encode_portrait` 정합 —
 * orch가 `/api/agents/{id}/portrait` route 응답에 그대로 사용하므로 fs 접근 비용은 등록 시점에만
 * 발생한다. 캐시는 *경로 기준* (절대 경로 안정성 가정).
 *
 * 실패는 graceful — 경로가 없거나 파일이 읽히지 않으면 null. wire에 portrait_b64 키 자체를
 * 박지 않아 orch가 portrait_url만으로 fallback 한다 (Python 정본과 동일 graceful).
 */
const portraitCache = new Map<string, string>();

export function encodePortrait(path: string): string | null {
  const cached = portraitCache.get(path);
  if (cached !== undefined) return cached;
  try {
    const buf = readFileSync(path);
    const b64 = buf.toString("base64");
    portraitCache.set(path, b64);
    return b64;
  } catch {
    return null;
  }
}

/** 테스트 용도 — 모듈 레벨 캐시 격리. */
export function _resetPortraitCacheForTest(): void {
  portraitCache.clear();
}

/**
 * node_register payload 조립. wire-schema NodeRegister 타입 정본 사용.
 *
 * Phase B-3 (R3): agents·supported_backends·max_concurrent를 *agentRegistry yaml*에서 동적으로
 * 채운다. B-2의 하드코드 `codex-default` 광고는 제거.
 *
 * Phase B-6 후속 (분석 캐시 `20260518-1045-codex-network-sync-portrait.md` Part C): agents 매핑에
 * `portrait_url`·`portrait_b64`를 추가 (Python `adapter.py:212-233` 정본 정합). orch는
 * `/api/agents/{id}/portrait` route를 portrait_b64로 응답한다 — 미박 시 응답 비어 대시보드의
 * 에이전트 portrait가 미표시되던 결함을 차단.
 *
 * - max_concurrent = agents.length (각 agent 동시 1 turn 모델 — Codex 단일턴)
 * - supported_backends = registry의 중복 제거 backend 목록
 * - agents = registry.list() 매핑 (id, name, backend, portrait_url, portrait_b64?)
 *   · portrait_path 미설정 시 portrait_url = "" + portrait_b64 키 미박힘
 *   · portrait_path 설정 + 파일 read 실패 시 portrait_url은 유지(URL만 광고), portrait_b64 미박힘
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
    agents: agents.map((a) => {
      const entry: NonNullable<NodeRegister["agents"]>[number] = {
        id: a.id,
        name: a.name,
        backend: a.backend,
        portrait_url: a.portrait_path ? `/api/agents/${a.id}/portrait` : "",
      };
      if (a.portrait_path) {
        const b64 = encodePortrait(a.portrait_path);
        if (b64) {
          entry.portrait_b64 = b64;
        }
      }
      return entry;
    }),
  };
  if (params.userName) {
    msg.user = {
      name: params.userName,
      hasPortrait: false,
    };
  }
  return msg;
}
