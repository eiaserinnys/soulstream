import type {
  PlannerPageDto,
  PlannerTaskDto,
  PlannerTodayDto,
} from "./planner_contract.js";

export type PlannerKind = "today" | "project";

export interface RawPlannerProjectDto {
  project: PlannerPageDto;
  tasks: PlannerTaskDto[];
  documents: PlannerPageDto[];
}

export interface PlannerPayloadRow extends Record<string, unknown> {
  payload: PlannerTodayDto | RawPlannerProjectDto | null;
  next_task_position: string | null;
  next_task_id: string | null;
  next_document_position: string | null;
  next_document_id: string | null;
}

export interface ProjectReadInput {
  taskCursor?: string;
  documentCursor?: string;
  taskLimit: number;
  documentLimit: number;
  includeTasks: boolean;
  includeDocuments: boolean;
}
