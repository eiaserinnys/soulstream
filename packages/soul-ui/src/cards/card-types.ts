import type { CardStatus } from "@soulstream/wire-schema";
export type { CardStatus } from "@soulstream/wire-schema";
export interface CardRow {
  id: string; folderId: string; title: string; request: string; brief: string;
  status: CardStatus; blockedKind: "limit" | "question" | "no_report" | null;
  blockedDetail: string | null; positionKey: string; queuePositionKey: string | null;
  assigneeKind: "agent" | "human" | "session" | null;
  assigneeAgentId: string | null; assigneeUserId: string | null; assigneeSessionId: string | null;
  nodeId: string | null; modelPreset: string | null; version: number; archived: boolean;
  createdAt: string; updatedAt: string;
}
export interface CardReport { id: string; title: string; format: "markdown" | "html"; body: string; createdAt: string; sessionId: string | null }
export interface CardQuestion { id: string; text: string; options: string[] | null; answer: string | null; askedAt: string; answeredAt: string | null }
export interface CardLinkedSession { sessionId: string; cardId: string; displayName: string | null; nodeId: string; agentId: string; status: import("../shared/session-types").SessionStatus; createdAt: string; callerSessionId: string | null; updatedAt: string }
export interface CardComment { id: string; cardId: string; authorKind: "user" | "agent"; authorId: string; sessionId: string | null; kind: "comment" | "spoken"; body: string; createdAt: string }
export interface CardDetail { card: CardRow; reports: CardReport[]; questions: CardQuestion[]; sessions: CardLinkedSession[]; comments?: CardComment[] }
export interface CardAssignment { folderId: string; nodeId: string; agentId: string; modelPreset: string }
