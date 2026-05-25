import { readFileSync } from "node:fs";

import type { Logger } from "pino";

import type { NodeRegister } from "@soulstream/wire-schema";

import type { AgentRegistry } from "../agent_registry.js";

export interface RegistrationParams {
  nodeId: string;
  host: string;
  port: number;
  userName: string;
  userPortraitPath?: string;
  agentRegistry: AgentRegistry;
  /**
   * portrait 파일 read 실패(설정 오류·권한 등)를 운영자에게 노출하기 위한 logger. 미주입 시
   * 실패는 silent (테스트·legacy 호환).
   */
  logger?: Logger;
}

/**
 * portrait 파일을 base64로 인코딩한다. Python `upstream/adapter.py:_encode_portrait` 정합 —
 * orch가 `/api/agents/{id}/portrait` route 응답에 그대로 사용하므로 fs 접근 비용은 등록 시점에만
 * 발생한다. 캐시는 *경로 기준* (절대 경로 안정성 가정).
 *
 * **mtime invalidation 없음** — Python `portrait_utils.py:141`은 mtime 비교 캐시. 본 TS 구현은
 * 단순 in-memory Map. portrait 파일을 교체했을 때 본 노드 *재기동 없이는 stale*. agents.yaml
 * hot reload·portrait 교체 운영은 노드 재기동을 동반해야 한다.
 *
 * **Python 정본과 base64 내용물 차이 (의도된 부채)**: Python은 PIL로 64×64 RGBA PNG로
 * 리사이즈한 후 base64 (`portrait_utils.py:91-100`). TS는 raw bytes 그대로 base64. 운영
 * agents.yaml의 portrait가 *이미 적정 해상도 PNG*로 사전 처리된 경우에만 wire 페이로드가
 * 합리적. 본 PR 머지 시점 정본 점검: 운영 `seosoyoung_codex/portrait/agent.png` = 512x512 PNG
 * 332KB → base64 ~443KB. 별 카드(sharp 등 리사이즈 등가 라이브러리)에서 정합.
 *
 * 실패는 graceful — 경로가 없거나 파일이 읽히지 않으면 null + logger.warn으로 통지. wire에
 * portrait_b64 키 자체를 박지 않아 orch가 portrait_url만으로 fallback 한다.
 */
const portraitCache = new Map<string, string>();

export function encodePortrait(path: string, logger?: Logger): string | null {
  const cached = portraitCache.get(path);
  if (cached !== undefined) return cached;
  try {
    const buf = readFileSync(path);
    const b64 = buf.toString("base64");
    portraitCache.set(path, b64);
    return b64;
  } catch (err) {
    // ENOENT(설정 오류)·EACCES(권한)·EISDIR 등을 silent 흡수하지 않고 통지. design-principles §4·§8.
    if (logger) {
      logger.warn({ err, path }, "portrait read failed — wire에 portrait_b64 미박힘");
    }
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
 * - reflect_brief = true (orchestrator cogito aggregate가 TS node만 대상으로 삼는 capability)
 * - supported_backends = registry의 중복 제거 backend 목록
 * - agents = registry.list() 매핑 (id, name, backend, portrait_url, portrait_b64?)
 *   · portrait_path 미설정 시 portrait_url = "" + portrait_b64 키 미박힘
 *   · portrait_path 설정 + 파일 read 실패 시 portrait_url은 유지(URL만 광고), portrait_b64 미박힘
 * - user = userName이 있을 때 광고 (name, hasPortrait, portrait_b64?)
 *   · userPortraitPath 설정 + 파일 read 성공 시 hasPortrait=true + portrait_b64
 *   · read 실패 시 hasPortrait=false (orch 프록시가 깨진 URL을 만들지 않도록 명시)
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
    capabilities: { max_concurrent: agents.length, reflect_brief: true },
    supported_backends: params.agentRegistry.supportedBackends(),
    agents: agents.map((a) => {
      const entry: NonNullable<NodeRegister["agents"]>[number] = {
        id: a.id,
        name: a.name,
        backend: a.backend,
        portrait_url: a.portrait_path ? `/api/agents/${a.id}/portrait` : "",
      };
      if (a.portrait_path) {
        const b64 = encodePortrait(a.portrait_path, params.logger);
        if (b64) {
          entry.portrait_b64 = b64;
        }
      }
      return entry;
    }),
  };
  if (params.userName) {
    const portraitB64 = params.userPortraitPath
      ? encodePortrait(params.userPortraitPath, params.logger)
      : null;
    msg.user = {
      name: params.userName,
      hasPortrait: Boolean(portraitB64),
    };
    if (portraitB64) {
      msg.user.portrait_b64 = portraitB64;
    }
  }
  return msg;
}
