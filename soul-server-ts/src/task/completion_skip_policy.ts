import { SESSION_MODEL_FALLBACK_REASON } from "@soulstream/wire-schema/model-preset-fallbacks";
import {
  resumeAfterLimitToolUseId,
  stableScheduleId,
} from "@soulstream/wire-schema/resume-after-limit";

import type { Task } from "./task_models.js";

/**
 * 완료 전달을 만들지 않아도 되는 까닭이다. 사람의 멈춤은 여기에 없다: 멈춤 버튼도 부른
 * 세션에 알린다(261112 디렉터 결정).
 */
export type CompletionSkipReason =
  | "notify_completion_off"
  | "no_caller"
  | "self_caller"
  | "next_generation_continues";

export type CompletionSkipDecision =
  | { skip: CompletionSkipReason }
  | { skip: null; callerSessionId: string };

/**
 * 완료 전달의 생략 조건을 정하는 유일한 함수다. 종료 정리(정상 길)와 재시작 뒤 훑기가
 * 같이 쓴다. 부른 세션 조회는 완료 알림 끔을 확인한 뒤에만 한다.
 */
export async function decideCompletionSkip(
  task: Task,
  resolveCallerSessionId: () => Promise<string | undefined>,
  nextGenerationContinues = false,
): Promise<CompletionSkipDecision> {
  if (task.notifyCompletion === false) return { skip: "notify_completion_off" };
  if (nextGenerationContinues) return { skip: "next_generation_continues" };
  const callerSessionId = await resolveCallerSessionId();
  if (!callerSessionId) return { skip: "no_caller" };
  if (callerSessionId === task.agentSessionId) return { skip: "self_caller" };
  return { skip: null, callerSessionId };
}

export interface ScheduleReservation {
  scheduleId: string;
  toolUseId: string | null;
}

/**
 * 「다음 세대가 이어 감」으로 완료 전달을 생략해도 되는지 본다. 다음 모델 세대가 예고돼
 * 있고 그 종료의 이어가기 예약이 그 세션의 예약 목록에 실제로 있을 때만 참이다.
 * 예약이 없으면 이어 갈 주체가 없으므로 생략하지 않는다.
 */
export async function nextGenerationContinues(
  task: Task,
  listReservations: (sessionId: string) => Promise<readonly ScheduleReservation[]>,
): Promise<boolean> {
  if (task.persistentGeneration?.pending?.reason !== SESSION_MODEL_FALLBACK_REASON) {
    return false;
  }
  const terminalEventId = task.terminalEventId;
  if (terminalEventId === undefined) return false;
  const scheduleId = stableScheduleId(task.agentSessionId, terminalEventId, 0);
  const toolUseId = resumeAfterLimitToolUseId(terminalEventId);
  const reservations = await listReservations(task.agentSessionId);
  return reservations.some((reservation) =>
    reservation.scheduleId === scheduleId || reservation.toolUseId === toolUseId);
}
