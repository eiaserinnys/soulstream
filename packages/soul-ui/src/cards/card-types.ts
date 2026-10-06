import type { CardAttachment } from "@soulstream/wire-schema/card-attachments";
export type {CardAttachment} from "@soulstream/wire-schema/card-attachments";
import type { CardColor } from "@soulstream/wire-schema/card-colors";
export type { CardColor } from "@soulstream/wire-schema/card-colors";
export { CARD_COLOR_KEYS, CARD_COLORS } from "@soulstream/wire-schema/card-colors";
import type { CardStatus } from "@soulstream/wire-schema";
export type { CardStatus } from "@soulstream/wire-schema";
export interface CardActivity { kind: "instruction" | "report"; body: string; createdAt: string; format: "markdown" | "html" }
export type CardItemDisplay = "todo" | "doing" | "reported" | "changed" | "fix" | "confirmed" | "dropped";
export interface CardItemEvidence { type: "image" | "link"; url: string; label: string }
export interface CardCheckItem {
  id: number; title: string; state: "todo" | "doing" | "done" | "dropped"; result: string | null;
  evidence: CardItemEvidence[]; caveat: string | null; rev: number; confirmed: { at: string; rev: number } | null;
  fixOpen: number; reopened: string | null; from: { commentId: string; kind: "comment" | "spoken"; at: string } | null;
  createdAt: string; reportedAt: string | null; display: CardItemDisplay;
}
export interface CardNow { text: string; turn: "agent" | "user" | "outside"; ask: string | null; updatedAt: string; sessionId: string | null }
export interface CardNowHistoryEntry { text: string; turn: CardNow["turn"]; ask: string | null; at: string }
export interface CardRow {
  id: string; number?: number | null; folderId: string; title: string; request: string; brief: string;
  attachments: CardAttachment[];
  status: CardStatus; color?: CardColor; blockedKind: "limit" | "question" | "no_report" | null;
  blockedDetail: string | null; positionKey: string; queuePositionKey: string | null;
  assigneeKind: "agent" | "human" | "session" | null;
  assigneeAgentId: string | null; assigneeUserId: string | null; assigneeSessionId: string | null;
  nodeId: string | null; modelPreset: string | null; version: number; archived: boolean;
  createdAt: string; updatedAt: string;
  completedAt?: string | null;
  latestActivity?: CardActivity | null;
  items?: CardCheckItem[];
  now?: CardNow | null;
}
export interface CardReport { id: string; title: string; format: "markdown" | "html"; body: string; createdAt: string; sessionId: string | null }
export interface CardQuestion { id: string; text: string; options: string[] | null; answer: string | null; askedAt: string; answeredAt: string | null }
export interface CardLinkedSession { sessionId: string; cardId: string; displayName: string | null; nodeId: string; agentId: string; status: import("../shared/session-types").SessionStatus; createdAt: string; callerSessionId: string | null; updatedAt: string }
export interface CardComment { id: string; cardId: string; authorKind: "user" | "agent"; authorId: string; sessionId: string | null; kind: "comment" | "spoken" | "note"; itemId?: number | null; body: string; createdAt: string }
export interface CardDetail { card: CardRow; reports: CardReport[]; questions: CardQuestion[]; sessions: CardLinkedSession[]; comments?: CardComment[]; notes?: CardComment[]; nowHistory?: CardNowHistoryEntry[] }
export interface CardAssignment { folderId: string; nodeId: string; agentId: string; modelPreset: string }
