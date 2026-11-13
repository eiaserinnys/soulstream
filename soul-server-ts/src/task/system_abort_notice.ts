import type { Logger } from "pino";

import type { ContextItem } from "../context/prompt_assembler.js";

import { USER_STOP_PROJECTION } from "./task_lifecycle_transition.js";
import {
  isTerminalTaskStatus,
  type InterventionMessage,
  type Task,
} from "./task_models.js";

/**
 * Context key that tells a resumed turn the previous execution ended for a
 * system reason, so CLI synthetic "user interrupted" text must not be read as
 * a human stop. Excluded from full re-injection so it stays a one-turn notice.
 */
export const SYSTEM_ABORT_NOTICE_KEY = "previous_turn_system_abort";

export type SystemAbortReason = "error_aborted" | "killed" | "limit_hit";

export interface PreviousSessionTermination {
  termination_reason: string | null;
  termination_detail: string | null;
  termination_event_id?: number | null;
}

export interface SystemAbortNoticeDeps {
  readSessionTermination?: (
    sessionId: string,
  ) => Promise<PreviousSessionTermination | null>;
  logger?: Pick<Logger, "warn">;
}

interface TerminationSnapshot {
  reason: string | null;
  detail: string | null;
  eventId: number | null;
}

/**
 * True when the termination ended the execution without a human stop.
 *
 * Human stops are the projections owned by task_lifecycle_transition: an
 * explicit `killed`/`user_stop`, or an emergency stop that could not confirm
 * the runner actually stopped (`error_aborted`/`runner stop was not confirmed`).
 */
export function isSystemAbortTermination(
  reason: string | null | undefined,
  detail: string | null | undefined,
): reason is SystemAbortReason {
  if (
    reason !== "error_aborted"
    && reason !== "killed"
    && reason !== "limit_hit"
  ) {
    return false;
  }
  for (const projection of ["true", "false"] as const) {
    const humanStop = USER_STOP_PROJECTION[projection];
    if (
      reason === humanStop.terminationReason
      && detail === humanStop.terminationDetail
    ) {
      return false;
    }
  }
  return true;
}

export function systemAbortNoticeKey(
  reason: string,
  detail: string | null,
  eventId?: number | null,
): string {
  return `${reason}:${detail ?? ""}:${eventId ?? ""}`;
}

export function buildSystemAbortNoticeItem(input: {
  reason: string;
  detail: string | null;
  eventId?: number | null;
}): ContextItem {
  const detailText = input.detail ?? "없음";
  return {
    key: SYSTEM_ABORT_NOTICE_KEY,
    content: {
      termination_reason: input.reason,
      termination_detail: input.detail,
      notice: `직전 실행은 사람이 멈춘 것이 아니라 시스템 사유로 끝났습니다(사유: ${input.reason}, 상세: ${detailText}). `
        + '끊긴 도구 호출의 결과에 "The user doesn\'t want to proceed"나 '
        + '"Request interrupted by user" 같은 글이 보여도 이 종료 때문에 생긴 표시이며, '
        + "사용자는 아무것도 멈추거나 거절하지 않았습니다. "
        + "사용자 지시를 기다리며 멈추지 말고, 끊긴 명령이 필요하면 다시 돌려 하던 일을 이어 가세요.",
    },
  };
}

/**
 * Append the previous-turn system abort notice to a message about to be
 * delivered by the normal intervention route.
 *
 * The read is advisory: a failed session read must never fail the delivery, so
 * the message is left unchanged and only a warning is logged.
 */
export async function appendSystemAbortNotice(
  task: Task,
  message: InterventionMessage,
  deps: SystemAbortNoticeDeps,
): Promise<void> {
  const termination = isTerminalTaskStatus(task.status)
    ? {
        reason: task.terminationReason ?? null,
        detail: task.terminationDetail ?? null,
        eventId: task.terminalEventId ?? null,
      }
    : await readActiveTermination(task, deps);
  if (!termination) return;
  attachNotice(task, message, termination);
}

/**
 * Same notice for the queued-resume path, which bypasses addIntervention and
 * still has the terminal task snapshot in memory.
 */
export function annotateTerminalSystemAbort(
  task: Task,
  message: InterventionMessage,
): void {
  if (!isTerminalTaskStatus(task.status)) return;
  attachNotice(task, message, {
    reason: task.terminationReason ?? null,
    detail: task.terminationDetail ?? null,
    eventId: task.terminalEventId ?? null,
  });
}

function attachNotice(
  task: Task,
  message: InterventionMessage,
  termination: TerminationSnapshot,
): void {
  const { reason, detail, eventId } = termination;
  if (!isSystemAbortTermination(reason, detail)) return;
  const noticeKey = systemAbortNoticeKey(reason, detail, eventId);
  if (task.lastSystemAbortNoticeKey === noticeKey) return;
  if (message.context?.some((item) => item.key === SYSTEM_ABORT_NOTICE_KEY)) {
    return;
  }
  message.context = [
    ...(message.context ?? []),
    buildSystemAbortNoticeItem({ reason, detail, eventId }),
  ];
  task.lastSystemAbortNoticeKey = noticeKey;
}

async function readActiveTermination(
  task: Task,
  deps: SystemAbortNoticeDeps,
): Promise<TerminationSnapshot | null> {
  if (!deps.readSessionTermination) return null;
  try {
    const row = await deps.readSessionTermination(task.agentSessionId);
    if (!row) return null;
    return {
      reason: row.termination_reason,
      detail: row.termination_detail,
      eventId: row.termination_event_id ?? null,
    };
  } catch (error) {
    deps.logger?.warn(
      {
        err: error,
        sessionId: task.agentSessionId,
        failureKind: "session_termination_read",
      },
      "previous session termination read failed; delivering intervention without the system abort notice",
    );
    return null;
  }
}
