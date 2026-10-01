import { plannerContextCount } from '../lib/planner-context-chips';
import type { CatalogFolder } from './types';
import type { CardDto } from './cardTypes';

export type PlannerFolderStatus = 'open' | 'in_progress' | 'review' | 'completed';

export interface PlannerPageWire {
  id: string;
  title: string;
  daily_date: string | null;
  version: number;
  archived: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}
export interface PlannerBlockWire {
  id: string;
  page_id: string;
  parent_id: string | null;
  position_key: string;
  block_type: string;
  text: string;
  properties: Record<string, unknown>;
  collapsed: boolean;
}

export interface PlannerSessionSummaryWire {
  agentSessionId: string;
  cardId?: string | null;
  folderId: string | null;
  displayName: string | null;
  nodeId: string | null;
  sessionType: string | null;
  status: string | null;
  eventCount: number;
  agentId: string | null;
  modelPreset?: string | null;
  reasoningEffort?: string | null;
  callerSessionId?: string | null;
  predecessorSessionId: string | null;
  reviewState: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlannerFolderWire {
  page: PlannerPageWire;
  folder: CatalogFolder;
  itemCounts: Record<string, number>;
  itemTotal: number;
  completedItemCount: number;
  assignee: string | null;
}

export interface PlannerPageSliceWire<T> {
  items: T[];
  nextCursor: string | null;
}

export interface PlannerTodayWire {
  attention: CardDto[];
  running: CardDto[];
  queued: CardDto[];
  daily: {
    page: PlannerPageWire;
    blocks: PlannerBlockWire[];
    state_vector: string;
  };
  memoBlocks: PlannerBlockWire[];
  folders: PlannerFolderWire[];
  reviewSessionIds: string[];
}

export interface PlannerFolderDetailWire {
  folder: CatalogFolder;
  page: PlannerPageWire;
  blocks: PlannerBlockWire[];
  cards: CardDto[];
  subfolders: { items: CatalogFolder[]; nextCursor: string | null };
  sessions: { items: PlannerSessionSummaryWire[]; nextCursor: string | null };
}

export interface PlannerFolderDetail {
  folder: CatalogFolder;
  page: PlannerPage;
  blocks: PlannerBlock[];
  cards: CardDto[];
  subfolders: { items: CatalogFolder[]; nextCursor: string | null };
  sessions: PlannerPageSlice<PlannerSessionSummary>;
}

export interface PlannerPage {
  id: string;
  title: string;
  dailyDate: string | null;
  version: number;
  archived: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface PlannerBlock {
  id: string;
  pageId: string;
  parentId: string | null;
  positionKey: string;
  blockType: string;
  text: string;
  properties: Record<string, unknown>;
  collapsed: boolean;
}

export interface PlannerFolderSummary {
  id: string;
  title: string;
  status: string;
  archived: boolean;
  version: number;
  itemCounts: Record<string, number>;
  itemTotal: number;
  completedItemCount: number;
  assignee: string | null;
}

export interface PlannerSessionSummary {
  agentSessionId: string;
  cardId?: string | null;
  folderId: string | null;
  displayName: string | null;
  nodeId: string | null;
  sessionType: string | null;
  status: string | null;
  eventCount?: number;
  agentId: string | null;
  modelPreset?: string | null;
  /** 생성 시 확정된 effort. null이면 백엔드 기본값. 후계 상속의 원본. */
  reasoningEffort?: string | null;
  /** catalog session의 위임 부모. predecessorSessionId와 의미가 다르다. */
  callerSessionId?: string | null;
  predecessorSessionId: string | null;
  reviewState: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlannerFolder {
  page: PlannerPage;
  blocks: PlannerBlock[];
  folderId: string;
  folderSummary: PlannerFolderSummary | null;
  status: PlannerFolderStatus;
  assignee: string;
  contextCount: number;
  progress: number | null;
  projectPageId: string | null;
  parentFolderId?: string | null;
  sessions: PlannerSessionSummary[];
  sessionIds: string[];
}

export interface PlannerPageSlice<T> {
  items: T[];
  nextCursor: string | null;
}

export interface PlannerToday {
  attention: CardDto[];
  running: CardDto[];
  queued: CardDto[];
  daily: { page: PlannerPage; blocks: PlannerBlock[]; stateVector: string };
  projects: PlannerPage[];
  memoBlocks: PlannerBlock[];
  folders: PlannerFolder[];
  reviewSessionIds: string[];
}

export interface PlannerFolderCollection {
  project: PlannerPage;
  folders: PlannerPageSlice<PlannerFolder>;
}

export interface PlannerFolderSession {
  agentSessionId: string;
}

export type PlannerFolderSessionPage = PlannerPageSlice<PlannerFolderSession>;

type PlannerFolderParseSource = 'daily' | 'project' | 'project-page' | 'starred';

export function parsePlannerPage(raw: PlannerPageWire): PlannerPage {
  return {
    id: raw.id,
    title: raw.title,
    dailyDate: raw.daily_date,
    version: raw.version,
    archived: raw.archived,
    metadata: raw.metadata,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

export function parsePlannerBlock(raw: PlannerBlockWire): PlannerBlock {
  return {
    id: raw.id,
    pageId: raw.page_id,
    parentId: raw.parent_id,
    positionKey: raw.position_key,
    blockType: raw.block_type,
    text: raw.text,
    properties: raw.properties,
    collapsed: raw.collapsed,
  };
}

function parseFolderSummary(raw: PlannerFolderWire): PlannerFolderSummary {
  return {
    id: raw.folder.id,
    title: raw.folder.name,
    status: raw.folder.status,
    archived: raw.folder.archived,
    version: raw.folder.version,
    itemCounts: raw.itemCounts,
    itemTotal: raw.itemTotal,
    completedItemCount: raw.completedItemCount,
    assignee: raw.assignee,
  };
}

function parseSession(raw: PlannerSessionSummaryWire): PlannerSessionSummary {
  return {
    agentSessionId: raw.agentSessionId,
    cardId: raw.cardId,
    folderId: raw.folderId,
    displayName: raw.displayName,
    nodeId: raw.nodeId,
    sessionType: raw.sessionType,
    status: raw.status,
    eventCount: raw.eventCount,
    agentId: raw.agentId,
    modelPreset: raw.modelPreset ?? null,
    reasoningEffort: raw.reasoningEffort ?? null,
    callerSessionId: raw.callerSessionId ?? null,
    predecessorSessionId: raw.predecessorSessionId,
    reviewState: raw.reviewState,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

export function parsePlannerFolder(raw: PlannerFolderWire): PlannerFolder {
  const folderId = requiredFolderId(raw.folder.id);
  const folder = parseFolderSummary(raw);
  return {
    page: parsePlannerPage(raw.page),
    blocks: [],
    folderId,
    folderSummary: folder,
    status: plannerFolderStatus(folder),
    assignee: folder.assignee ?? '담당 미지정',
    contextCount: 0,
    progress: folder.itemTotal > 0
      ? Math.round((folder.completedItemCount / folder.itemTotal) * 100)
      : null,
    projectPageId: null,
    parentFolderId: raw.folder.parentFolderId,
    sessions: [],
    sessionIds: [],
  };
}

export function parsePlannerFolderPageSlice(
  raw: PlannerPageSliceWire<PlannerFolderWire>,
  source: PlannerFolderParseSource,
): PlannerPageSlice<PlannerFolder> {
  return {
    items: parsePlannerFolders(raw.items, source),
    nextCursor: raw.nextCursor,
  };
}

export function parsePlannerToday(raw: PlannerTodayWire): PlannerToday {
  return {
    attention: raw.attention,
    running: raw.running,
    queued: raw.queued,
    daily: {
      page: parsePlannerPage(raw.daily.page),
      blocks: raw.daily.blocks.map(parsePlannerBlock),
      stateVector: raw.daily.state_vector,
    },
    projects: [],
    memoBlocks: raw.memoBlocks.map(parsePlannerBlock),
    folders: parsePlannerFolders(raw.folders, 'daily'),
    reviewSessionIds: raw.reviewSessionIds,
  };
}

export function parsePlannerFolderDetail(raw: PlannerFolderDetailWire): PlannerFolderDetail {
  return {
    folder: raw.folder,
    page: parsePlannerPage(raw.page),
    blocks: raw.blocks.map(parsePlannerBlock),
    cards: raw.cards,
    subfolders: raw.subfolders,
    sessions: {
      items: raw.sessions.items.map(parseSession),
      nextCursor: raw.sessions.nextCursor,
    },
  };
}

export function plannerFolderDetailToSummary(detail: PlannerFolderDetail): PlannerFolder {
  const counts = detail.cards.filter((item) => !item.archived).reduce<Record<string, number>>(
    (result, item) => ({ ...result, [item.status]: (result[item.status] ?? 0) + 1 }),
    {},
  );
  const itemTotal = Object.values(counts).reduce((total, count) => total + count, 0);
  const completedItemCount = counts.done ?? 0;
  const summary: PlannerFolderSummary = {
    id: detail.folder.id,
    title: detail.folder.name,
    status: detail.folder.status,
    archived: detail.folder.archived,
    version: detail.folder.version,
    itemCounts: counts,
    itemTotal,
    completedItemCount,
    assignee: null,
  };
  return {
    page: detail.page,
    blocks: detail.blocks,
    folderId: detail.folder.id,
    folderSummary: summary,
    status: plannerFolderStatus(summary),
    assignee: '담당 미지정',
    contextCount: plannerContextCount(detail.blocks),
    progress: itemTotal ? Math.round(completedItemCount / itemTotal * 100) : null,
    projectPageId: null,
    parentFolderId: detail.folder.parentFolderId,
    sessions: detail.sessions.items,
    sessionIds: detail.sessions.items.map((session) => session.agentSessionId),
  };
}

function parsePlannerFolders(
  raw: readonly PlannerFolderWire[],
  _source: PlannerFolderParseSource,
): PlannerFolder[] {
  return raw.map(parsePlannerFolder);
}

function plannerFolderStatus(
  folder: PlannerFolderSummary | null,
): PlannerFolderStatus {
  if (!folder) return 'open';
  if (folder.status === 'completed') return 'completed';
  if ((folder.itemCounts.review ?? 0) > 0) return 'review';
  if ((folder.itemCounts.running ?? 0) > 0) return 'in_progress';
  return 'open';
}

function requiredFolderId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('폴더 응답에 folderId가 없습니다.');
  }
  return value.trim();
}
