export interface PlannerPageDto {
  id: string;
  title: string;
  daily_date: string | null;
  version: number;
  archived: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

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
  page: PlannerPageDto;
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
  daily: { page: PlannerPageDto; blocks: PlannerBlockDto[]; state_vector: string };
  folders: PlannerFolderDto[];
  memoBlocks: PlannerBlockDto[];
  reviewSessionIds: string[];
}

export interface PlannerFolderDetailDto {
  folder: Record<string, unknown>;
  page: PlannerPageDto;
  blocks: PlannerBlockDto[];
  sections: Record<string, unknown>[];
  items: Record<string, unknown>[];
  subfolders: PlannerPageSlice<Record<string, unknown>>;
  documents: PlannerPageSlice<PlannerPageDto>;
  sessions: PlannerPageSlice<PlannerSessionDto>;
}

export interface PlannerDailyHistoryDto { dates: string[] }
export interface PlannerPageInput { cursor?: string; limit: number }
export const PLANNER_READ_PAGE_LIMITS = {
  starredFolders: { default: 50, max: 100 },
  dailyHistory: { default: 2, max: 10 },
  folder: { default: 20, max: 50 },
} as const;

export interface PlannerReadProvider {
  getStarredFolders(input: PlannerPageInput): Promise<PlannerPageSlice<PlannerFolderDto>>;
  getDailyHistory(input: { before: string; limit: number }): Promise<PlannerDailyHistoryDto>;
  getToday(date: string): Promise<PlannerTodayDto | null>;
  getFolder(folderId: string, input: { limit: number }): Promise<PlannerFolderDetailDto | null>;
  getSubfolders(folderId: string, input: PlannerPageInput): Promise<PlannerPageSlice<Record<string, unknown>>>;
  getDocuments(folderId: string, input: PlannerPageInput): Promise<PlannerPageSlice<PlannerPageDto>>;
  getSessions(folderId: string, input: PlannerPageInput): Promise<PlannerPageSlice<PlannerSessionDto>>;
}
