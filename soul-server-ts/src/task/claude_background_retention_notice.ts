/**
 * 백그라운드 보유 알림 문구. 완료 알림(R4)과 보유 해제 알림(R3)이 같은
 * 어휘를 쓰도록 한 곳에 둔다.
 */

/** 클로드 백그라운드 보유 상한 기본값. 설정으로 바꿀 수 있다. */
export const DEFAULT_CLAUDE_BACKGROUND_RETENTION_CAP_MS = 60 * 60_000;

export const CLAUDE_BACKGROUND_STOPPED_SUFFIX = "이 세션은 더 보고하지 않습니다.";

export function claudeBackgroundRetentionCapMinutes(capMs: number): number {
  return Math.max(1, Math.round(capMs / 60_000));
}

/** 완료 알림에 붙는 줄 — 보유가 서서 이어서 보고한다. */
export function buildRetainedBackgroundNotice(
  remainingCount: number,
  capMs: number,
): string {
  return `백그라운드 작업 ${remainingCount}개가 아직 돌고 있습니다. `
    + `끝나면 이 세션이 이어서 다시 보고합니다`
    + `(최대 ${claudeBackgroundRetentionCapMinutes(capMs)}분).`;
}

/** 완료 알림에 붙는 줄 — 보유가 서지 않아 백그라운드가 닫혔다. */
export function buildStoppedBackgroundNotice(): string {
  return `백그라운드 작업이 남은 채 끝났고 그 작업은 멈췄습니다. `
    + CLAUDE_BACKGROUND_STOPPED_SUFFIX;
}

/** 보유 해제 알림 본문 — 까닭 문장 뒤에 같은 꼬리를 붙인다. */
export function buildBackgroundStoppedNotice(firstSentence: string): string {
  return `${firstSentence} ${CLAUDE_BACKGROUND_STOPPED_SUFFIX}`;
}

/** 보유 상한 초과로 멈춘 까닭. */
export function buildRetentionCapExceededSentence(capMs: number): string {
  return `백그라운드 작업이 ${claudeBackgroundRetentionCapMinutes(capMs)}분 안에 `
    + "끝나지 않아 멈췄습니다.";
}

/** 보유 없이 followup을 이을 수 없어 멈춘 까닭. */
export const CLAUDE_BACKGROUND_UNRECOVERABLE_SENTENCE =
  "백그라운드 작업이 끝났지만 이 세션을 이어 갈 수 없어 멈췄습니다.";

/** 러너가 죽어 백그라운드 작업을 이어 갈 수 없어 멈춘 까닭(R3). */
export const CLAUDE_BACKGROUND_RUNNER_DEAD_SENTENCE =
  "백그라운드 작업을 돌리던 실행기가 끝나 작업이 멈췄습니다.";
