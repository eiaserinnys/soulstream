import type { AssignedCardContextSnapshotEvent } from "@soulstream/wire-schema/assigned-card-context-snapshot";
import { formatBoardWorkspaceTime } from "../board-workspace/board-workspace-items";

type Snapshot = AssignedCardContextSnapshotEvent["capture"]["snapshot"];

export function formatAssignedCardContextSnapshot(snapshot: Snapshot): string {
  if (!snapshot.cards.length) return "담당 카드 없음";
  return snapshot.cards.map(card => [
    card.id,
    card.title.replace(/\s+/g," ").trim(),
    statusLabel(card.status),
    reportLabel(card),
    hasLaterComment(card) ? "최근 커멘트 이후 보고 없음" : null,
  ].filter(Boolean).join(" · ")).join("\n");
}

function reportLabel(card: Snapshot["cards"][number]): string {
  if (!Object.prototype.hasOwnProperty.call(card,"latestReportAt")) return "마지막 보고 시각 확인 불가";
  if (card.latestReportAt === null) return "보고 없음";
  const formatted = formatBoardWorkspaceTime(card.latestReportAt);
  return formatted === "..." ? "마지막 보고 시각 확인 불가" : `마지막 보고 ${formatted}`;
}

function hasLaterComment(card: Snapshot["cards"][number]): boolean {
  if (typeof card.latestCommentAt !== "string" || typeof card.latestReportAt !== "string") return false;
  return Date.parse(card.latestCommentAt) > Date.parse(card.latestReportAt);
}

function statusLabel(status: string): string {
  return ({todo:"할 일",queued:"대기",blocked:"막힘",running:"실행 중",review:"검수 대기",done:"완료",cancelled:"취소"} as Record<string,string>)[status] ?? status;
}
