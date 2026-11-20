import type { CardStatus } from "../generated/typescript/index.js";

export const CARD_STATUS_LABELS = {
  todo: "할 일",
  queued: "대기",
  blocked: "막힘",
  running: "실행 중",
  awaiting_verification: "검증 대기",
  review: "검수 대기",
  on_hold: "보류",
  done: "완료",
  cancelled: "취소",
} satisfies Record<CardStatus, string>;
