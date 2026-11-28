import type { PageDto } from "@soulstream/page-model";

export interface PlannerBlockDto {
  id: string;
  page_id: string;
  parent_id: string | null;
  position_key: string;
  block_type: string;
  text: string;
  properties: Record<string, unknown>;
  collapsed: boolean;
}

export interface PlannerFolderDto {
  folder: Record<string, unknown>;
  page: PageDto;
  itemCounts: Record<string, number>;
  itemTotal: number;
  completedItemCount: number;
  assignee: string | null;
}

export interface PlannerPageSlice<T> {
  items: T[];
  nextCursor: string | null;
}

export interface PlannerSessionDto extends Record<string, unknown> {
  agentSessionId: string;
  status: string;
  eventCount: number;
}

export interface PlannerTodayDto {
  attention: Record<string, unknown>[];
  running: Record<string, unknown>[];
  queued: Record<string, unknown>[];
  reviewSessionIds: string[];
}

export interface PlannerFolderDetailDto {
  folder: Record<string, unknown>;
  page: PageDto;
  blocks: PlannerBlockDto[];
  cards: Record<string, unknown>[];
  subfolders: PlannerPageSlice<Record<string, unknown>>;
  sessions: PlannerPageSlice<PlannerSessionDto>;
}

export interface PlannerPageInput { cursor?: string; limit: number }
export const PLANNER_READ_PAGE_LIMITS = {
  starredFolders: { default: 50, max: 100 },
  folder: { default: 20, max: 50 },
} as const;

export interface PlannerReadProvider {
  getStarredFolders(input: PlannerPageInput): Promise<PlannerPageSlice<PlannerFolderDto>>;
  getToday(): Promise<PlannerTodayDto>;
  getFolder(folderId: string, input: { limit: number; includeCompleted?: boolean }): Promise<PlannerFolderDetailDto | null>;
  getSubfolders(folderId: string, input: PlannerPageInput): Promise<PlannerPageSlice<Record<string, unknown>>>;
  getSessions(folderId: string, input: PlannerPageInput): Promise<PlannerPageSlice<PlannerSessionDto>>;
}
