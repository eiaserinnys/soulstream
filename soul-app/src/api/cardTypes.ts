import type { CatalogFolder, Session } from './types';
import type { CardColor } from '../../../packages/wire-schema/src/card_colors';

export type CardStatus = 'todo' | 'queued' | 'blocked' | 'running' | 'review' | 'done' | 'cancelled';
export interface CardAttachment {
  nodeId: string;
  path: string;
  name: string;
  mimeType: string;
}
export type CardItemDisplay = 'todo' | 'doing' | 'reported' | 'changed' | 'fix' | 'confirmed' | 'dropped';
export interface CardCheckItem {
  id: number;
  title: string;
  state: 'todo' | 'doing' | 'done' | 'dropped';
  result: string | null;
  evidence: Array<{ type: 'image' | 'link'; url: string; label: string }>;
  caveat: string | null;
  rev: number;
  confirmed: { at: string; rev: number } | null;
  fixOpen: number;
  reopened: string | null;
  from: { commentId: string; kind: 'comment' | 'spoken'; at: string } | null;
  createdAt: string;
  reportedAt: string | null;
  display: CardItemDisplay;
}
export interface CardNow {
  text: string;
  turn: 'agent' | 'user' | 'outside';
  ask: string | null;
  updatedAt: string;
  sessionId: string;
}
export interface CardNowHistoryEntry {
  text: string;
  turn: CardNow['turn'];
  ask: string | null;
  at: string;
}
export interface CardDto {
  id: string;
  /** Older server responses omit this field. */
  number?: number | null;
  color?: CardColor;
  folderId: string;
  title: string;
  request: string;
  /** Older server responses omit this field; readers treat omission as []. */
  attachments?: CardAttachment[];
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
  /** Omitted by older server responses. */
  items?: CardCheckItem[];
  /** Omitted by older server responses. */
  now?: CardNow | null;
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
  kind: 'comment' | 'spoken' | 'note';
  itemId?: number | null;
  body: string;
  createdAt: string;
}
export interface CardDetail {
  card: CardDto;
  reports: CardReport[];
  comments?: CardComment[];
  questions: CardQuestion[];
  sessions: Session[];
  notes?: CardComment[];
  nowHistory?: CardNowHistoryEntry[];
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
  color?: CardColor;
  title?: string;
  assignee?: { kind: 'agent' | 'human' | 'session' | null; agentId?: string | null; userId?: string | null; sessionId?: string | null } | null;
  nodeId?: string | null;
  modelPreset?: string | null;
}

export interface CardExecutionResult extends CardMutationResult {card:CardDto;execution:{requestId:string;sessionId:string;state:'started'|'already_running'|'pending'}}
