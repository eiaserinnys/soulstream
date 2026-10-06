/** 채택된 시안의 배치 치수. 공통 부품의 여백과 터치 치수는 theme이 소유한다. */
export const PERSISTENT_SESSION_FRAME = {
  landscape: { conversation: 480, tasks: 240, detail: 318 },
  portrait: { conversation: 400, tasks: 170, detail: 340 },
  header: 76,
  compactHeader: 56,
  compactHeight: 520,
} as const;
