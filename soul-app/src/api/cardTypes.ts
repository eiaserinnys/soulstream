import type { CatalogFolder, Session } from './types';

export type CardStatus = 'todo' | 'queued' | 'blocked' | 'running' | 'review' | 'done' | 'cancelled';
export interface CardDto {
  id: string;
  folderId: string;
  title: string;
  request: string;
  brief: string;
  status: CardStatus;
  positionKey: string;
  queuePositionKey: string | null;
  blockedKind: 'limit' | 'question' | 'no_report' | null;
  blockedDetail: string | null;
  assigneeKind: 'agent' | 'human' | 'session' | null;
  assigneeAgentId: string | null;
  assigneeSessionId: string | null;
  assigneeUserId: string | null;
  nodeId: string | null;
  modelPreset: string | null;
  archived: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
  latestActivity?: { kind: 'instruction' | 'report'; body: string; format: 'markdown' | 'html'; createdAt: string } | null;
}
export interface CardReport {
  id: string;
  cardId: string;
  title: string;
  format: 'html' | 'markdown';
  body: string;
  sessionId?: string | null;
  createdAt: string;
}
export interface CardQuestion {
  id: string;
  cardId: string;
  sessionId: string;
  text: string;
  options: string[] | null;
  answer: string | null;
  askedAt: string;
  answeredAt?: string | null;
}
export interface CardComment {
  id: string;
  cardId: string;
  authorKind: 'user' | 'agent';
  authorId: string | null;
  sessionId: string | null;
  kind: 'comment' | 'spoken';
  body: string;
  createdAt: string;
}
export interface CardDetail {
  card: CardDto;
  reports: CardReport[];
  comments?: CardComment[];
  questions: CardQuestion[];
  sessions: Session[];
}
export interface CardDetailWire extends Omit<CardDetail, 'sessions'> {
  sessions: Array<{ sessionId: string; cardId: string | null; displayName: string | null;
    nodeId: string | null; agentId: string | null; status: string; createdAt: string;
    updatedAt?: string; callerSessionId?: string | null }>;
}
export interface FolderSnapshot { folder: CatalogFolder; cards: CardDto[] }
export interface CardMutationResult { folderId: string; card: CardDto | null }
export interface CardAssignment {
  folderId: string;
  nodeId: string | null;
  agentId: string | null;
  modelPreset: string | null;
}
export interface CardPatch {
  title?: string;
  assignee?: { kind: 'agent' | 'human' | 'session' | null; agentId?: string | null; userId?: string | null; sessionId?: string | null } | null;
  nodeId?: string | null;
  modelPreset?: string | null;
}
