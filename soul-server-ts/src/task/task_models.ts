/**
 * Task 모델 — Codex 전담 흐름 (Phase B-3 기본 + B-4 resume/intervention).
 *
 * Python `service/task_models.py::Task` 정본을 *참조*하되 *코드 복사 아님*
 * (4차 캐시 §7.3 시그니처 동등 의무 없음, atom d7a1ad86 정본 둘 안티패턴 회피).
 *
 * 본 PR에서 *사용*하지 않는 Python 필드는 의도적 미포함:
 *   - claude 전용 (allowed_tools/disallowed_tools 런타임 사본, use_mcp, oauth_token, system_prompt)
 *   - LLM proxy (llm_provider, llm_model, llm_usage)
 *   - _deliver_input_response (AskUserQuestion 미구현)
 *   - pending_folder_id (folder 배정은 B-4 후속 PR-B 범위)
 *
 * B-4 추가 필드 (분석 캐시 `20260517-1410-codex-ts-folder-resume-intervene.md` §D):
 *   - interventionQueue: turn 사이 큐잉되는 사용자 메시지. claude
 *     `task_models.py` intervention_queue(asyncio.Queue) 정본과 의미 동등.
 *     codex SDK는 turn-level steer 미지원이라 turn 종료 후 dequeue → 다음 turn으로 처리.
 */

import type { EnginePort } from "../engine/protocol.js";

/** task lifecycle 상태. Python `TaskStatus` enum과 값 일치 (DB sessions.status 컬럼 정본). */
export type TaskStatus = "running" | "completed" | "error" | "interrupted";

/**
 * 사용자가 turn 사이에 보내는 개입 메시지. claude `task_manager.py:603-608`의 message dict와
 * *키 동등* (wire payload에 그대로 운반 가능).
 */
export interface InterventionMessage {
  text: string;
  user: string;
  callerInfo?: CallerInfo;
  attachmentPaths?: string[];
}

/**
 * 발신자 정보. atom card `ed3a216d-2811-4792-bfbe-f15043c7faba` (caller_info 통합 스키마 v1) 정본.
 *
 * snake_case keys = wire 전달 시 그대로 운반 (orch broadcast wire 정합).
 */
export interface CallerInfo {
  source?: string;
  display_name?: string;
  avatar_url?: string;
  user_id?: string;
  agent_node?: string;
  agent_id?: string;
  agent_name?: string;
  [k: string]: unknown;
}

/** session_broadcaster.emit_session_message_updated의 last_message dict 정본. */
export interface LastMessage {
  type: string;
  preview: string;
  timestamp: string;
}

/**
 * Task — Codex 세션 1개의 런타임 상태.
 *
 * 단일 turn 모델 (Codex 단일턴, B-3 범위) — 멀티턴은 B-4 검토.
 *
 * 영속화 책임: TaskManager가 `session_register` stored procedure로 *불변 필드* (agentSessionId,
 * nodeId, profileId, callerSessionId)만 박는다. 가변 필드(status, last_event_id 등)는
 * `session_update`로 진행 중 갱신.
 */
export interface Task {
  agentSessionId: string;
  prompt: string;
  status: TaskStatus;

  /** Agent registry 프로필 id (sessions.agent_id 컬럼). */
  profileId?: string;

  /**
   * Codex SDK가 발급한 thread id. 첫 ThreadStartedEvent에서 어댑터가 채움.
   * sessions.claude_session_id 컬럼에 박힘 — Codex 백엔드라도 컬럼 의미가
   * "backend session id"로 일반화됨 (Phase A AgentProfile.backend 도입 정합).
   */
  codexThreadId?: string;

  callerSessionId?: string;
  callerInfo?: CallerInfo;

  /** 모델 override (Codex SDK ThreadOptions.model). */
  model?: string;

  /**
   * B-6 context_builder: 사용자/위임자가 지정한 system_prompt. Python `task_models.Task.system_prompt`
   * 정합. context_builder가 folder_prompt와 조합하여 codex 첫 turn prompt에 prepend.
   *
   * codex SDK 0.130.0은 turn-level systemPrompt 미지원이라 prompt 문자열 prepend로 처리
   * (분석 캐시 `20260517-2338-codex-ts-context-builder-B-6.md` §B).
   */
  systemPrompt?: string;

  createdAt: Date;
  completedAt?: Date;

  /** DB events.id 최신값. event_append 반환값으로 갱신. */
  lastEventId: number;
  lastReadEventId: number;

  /** session_updated wire에 박힘 — text_delta accumulation 결과. */
  lastAssistantText?: string;
  lastProgressText?: string;

  /** 정상 완료 시 결과 텍스트, 실패 시 error 메시지. */
  result?: string;
  error?: string;

  // === 런타임 전용 (DB·wire에 직접 박지 않음) ===

  /** 진행 중 turn의 어댑터. cancelTask()에서 engine.interrupt() 호출 대상. */
  engine?: EnginePort;

  /** task_executor.startExecution 반환 promise. shutdown 시 await. */
  executionPromise?: Promise<void>;

  /**
   * Turn 사이 큐잉되는 개입 메시지 (B-4, claude `task_manager.py:603-609`의 asyncio.Queue
   * 정본과 의미 동등). codex SDK는 turn-level steer 미지원이라 turn 종료 후 dequeue → 다음
   * turn으로 자동 진입. Running 중 push되면 즉시 intervention_sent 발행(다른 클라이언트
   * 진행 인지) + 현재 turn 자연 종료 후 다음 turn에 prompt로 주입.
   *
   * 단일 process·단일 task_manager Map이라 별도 mutex 불요 — async await 경계만 정합.
   */
  interventionQueue: InterventionMessage[];
}
