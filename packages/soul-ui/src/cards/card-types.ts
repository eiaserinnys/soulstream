import type { CardAttachment } from "@soulstream/wire-schema/card-attachments";
import type { AttachmentDescriptor } from "@soulstream/wire-schema/attachments";
import type { CardQuestionAttachment, CardQuestionKind, CardQuestionOption } from "@soulstream/wire-schema/card-questions";
import type { CardColor } from "@soulstream/wire-schema/card-colors";
import type { CardStatus } from "@soulstream/wire-schema";
import type { CardItemDisplay } from "@soulstream/wire-schema/card-item-display";
import type { CardDependency } from "@soulstream/wire-schema/card-dependency-display";
export interface CardActivity { kind: "instruction" | "report"; body: string; createdAt: string; format: "markdown" | "html" }
export interface CardItemEvidence {
  type: "image" | "link";
  url: string;
  label: string;
  attachment_id?: string;
  descriptor?: AttachmentDescriptor;
  read_context?: { type: "card"; id: string };
  previewUrl?: string | null;
  originalUrl?: string;
  availability?: "missing" | "unavailable";
}
export interface CardCheckItem {
  id: number; title: string; state: "todo" | "doing" | "done" | "dropped"; result: string | null;
  evidence: CardItemEvidence[]; caveat: string | null; rev: number; confirmed: { at: string; rev: number } | null;
  fixOpen: number; reopened: string | null; from: { commentId: string; kind: "comment" | "spoken"; at: string } | null;
  createdAt: string; reportedAt: string | null; display: CardItemDisplay;
}
export interface CardNow { text: string | null; turn: "agent" | "user" | "outside"; ask: string | null; updatedAt: string; sessionId: string | null }
export interface CardNowHistoryEntry { text: string; turn: CardNow["turn"]; ask: string | null; at: string }
/** 카드 상세가 싣는 상태 전환 이력(최신 20개). 서버 단위가 더하기 전 응답에는 없다. */
export interface CardStatusHistoryEntry { status: CardStatus; at: string; actorKind: string | null; sessionId: string | null }
/** 카드 목록·상세 응답이 싣는 담당 에이전트 표시 정보. 담당이 없거나 사람이면 null이다. */
export interface CardAssigneeAgent {
  agentId: string; nodeId: string | null;
  agentName: string | null; portraitUrl: string | null;
  modelPreset: string | null; modelLabel: string | null;
}
export interface CardRow {
  id: string; number?: number | null; folderId: string; title: string; request: string; brief: string;
  attachments: CardAttachment[];
  status: CardStatus; color?: CardColor; blockedKind: "limit" | "question" | "no_report" | null;
  blockedDetail: string | null; wakeAt?: string | null; waitingFor?: string | null;
  positionKey: string; queuePositionKey: string | null;
  assigneeKind: "agent" | "human" | "session" | null;
  assigneeAgentId: string | null; assigneeUserId: string | null; assigneeSessionId: string | null;
  assigneeAgent?: CardAssigneeAgent | null;
  nodeId: string | null; modelPreset: string | null; version: number; archived: boolean;
  createdAt: string; updatedAt: string; statusChangedAt?: string;
  completedAt?: string | null;
  /** 사용자가 답변을 미뤄 둔 시각(ISO). 없거나 null이면 미루지 않았다. 서버 단위가 더하기 전 응답에는 없다. */
  snoozedUntil?: string | null;
  latestActivity?: CardActivity | null;
  items?: CardCheckItem[];
  now?: CardNow | null;
  dependsOn?: CardDependency[];
}
export interface CardReport { id: string; title: string; format: "markdown" | "html"; body: string; createdAt: string; sessionId: string | null }
export interface CardQuestion {
  id: string; text: string; options: string[] | null; answer: string | null; askedAt: string; answeredAt: string | null;
  withdrawnAt?: string | null; withdrawalReason?: string | null;
  title?: string | null; kind?: CardQuestionKind; optionDetails?: CardQuestionOption[];
  attachments?: CardQuestionAttachment[]; selectedOption?: string | null; revision?: number; revisedAt?: string | null;
}
export interface CardLinkedSession { sessionId: string; cardId: string; displayName: string | null; nodeId: string; agentId: string; status: import("@soulstream/wire-schema").SessionStatus; createdAt: string; callerSessionId: string | null; updatedAt: string
  agentName?: string | null; agentPortraitUrl?: string | null;
  modelPreset?: string | null; modelLabel?: string | null; backend?: string | null }
export interface CardComment { id: string; cardId: string; authorKind: "user" | "agent"; authorId: string; sessionId: string | null; kind: "comment" | "spoken" | "note"; itemId?: number | null; questionId?: string | null; body: string; createdAt: string }
export interface CardDetail { card: CardRow; reports: CardReport[]; questions: CardQuestion[]; sessions: CardLinkedSession[]; comments?: CardComment[]; notes?: CardComment[]; nowHistory?: CardNowHistoryEntry[]; statusHistory?: CardStatusHistoryEntry[] }
export interface CardAssignment { folderId: string; nodeId: string; agentId: string; modelPreset: string }
