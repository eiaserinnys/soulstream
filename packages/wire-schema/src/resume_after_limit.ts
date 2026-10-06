export const SOURCE_TOOL = "ResumeAfterLimit";
export const SCHEDULE_PROMPT = "리밋 해제 시각이 지났습니다. 이전 지시와 미완료 작업을 이어서 진행해주세요.";

export function resumeAfterLimitToolUseId(terminalEventId: number): string {
  return `${SOURCE_TOOL}:${terminalEventId}`;
}

export function stableScheduleId(
  sessionId: string,
  terminalEventId: number,
  generation: number,
): string {
  return `resume-after-limit:${sessionId}:${terminalEventId}:${generation}`;
}
