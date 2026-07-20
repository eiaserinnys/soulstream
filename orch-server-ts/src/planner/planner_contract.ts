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

export interface PlannerTaskSummaryDto {
  id: string;
  board_item_id: string;
  title: string;
  status: string;
  archived: boolean;
  version: number;
  created_session_id: string | null;
  created_event_id: number | null;
  created_at: string;
  updated_at: string;
  item_counts: Record<string, number>;
  item_total: number;
  completed_item_count: number;
  assignee: string | null;
}

export interface PlannerSessionSummaryDto {
  agent_session_id: string;
  folder_id: string | null;
  display_name: string | null;
  node_id: string | null;
  session_type: string | null;
  status: string | null;
  agent_id: string | null;
  predecessor_session_id: string | null;
  review_state: string;
  created_at: string;
  updated_at: string;
}

export interface PlannerMountedDocumentDto {
  block_id: string;
  page: PlannerPageDto;
}

export interface PlannerTaskDto {
  page: PlannerPageDto;
  blocks: PlannerBlockDto[];
  task_id: string;
  task: PlannerTaskSummaryDto | null;
  project_page_id: string | null;
  sessions: PlannerSessionSummaryDto[];
  mounted_documents: PlannerMountedDocumentDto[];
}

export interface PlannerPageSlice<T> {
  items: T[];
  next_cursor: string | null;
}

export interface PlannerTodayDto {
  daily: {
    page: PlannerPageDto;
    blocks: PlannerBlockDto[];
    state_vector: string;
  };
  projects: PlannerPageDto[];
  memo_blocks: PlannerBlockDto[];
  tasks: PlannerTaskDto[];
  review_session_ids: string[];
}

export interface PlannerProjectDto {
  project: PlannerPageDto;
  tasks: PlannerPageSlice<PlannerTaskDto>;
  documents: PlannerPageSlice<PlannerPageDto>;
}

export interface PlannerDailyHistoryDto {
  dates: string[];
}

export interface PlannerTaskRunPageDto extends PlannerPageSlice<{
  agent_session_id: string;
}> {
  total: number;
}

export interface PlannerReadProvider {
  getStarredTasks(input: {
    cursor?: string;
    limit: number;
    detail?: "full";
  }): Promise<PlannerPageSlice<PlannerPageDto | PlannerTaskDto>>;
  getDailyHistory(input: { before: string; limit: number }): Promise<PlannerDailyHistoryDto>;
  getToday(date: string): Promise<PlannerTodayDto | null>;
  getProject(pageId: string, input: { limit: number }): Promise<PlannerProjectDto | null>;
  getProjectTasks(
    pageId: string,
    input: { cursor?: string; limit: number },
  ): Promise<PlannerPageSlice<PlannerTaskDto> | null>;
  getProjectDocuments(
    pageId: string,
    input: { cursor?: string; limit: number },
  ): Promise<PlannerPageSlice<PlannerPageDto> | null>;
  getTaskRuns(
    pageId: string,
    input: { cursor?: string; limit: number },
  ): Promise<PlannerTaskRunPageDto | null>;
}
