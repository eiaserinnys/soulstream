import type { LiveDbSqlResolver } from "../runtime/live_db_sql.js";
import type {
  PlannerPageDto,
  PlannerPageSlice,
  PlannerProjectDto,
  PlannerReadProvider,
  PlannerTaskDto,
  PlannerTaskRunPageDto,
  PlannerTodayDto,
} from "./planner_contract.js";
import {
  encodeMountCursor,
  listDailyHistory,
  listStarredTasks,
  listTaskRuns,
  type PlannerMountCursor,
} from "./planner_repository_reads.js";
import {
  plannerQuery,
} from "./planner_aggregate_query.js";
import type {
  PlannerKind,
  PlannerPayloadRow,
  ProjectReadInput,
  RawPlannerProjectDto,
} from "./planner_aggregate_types.js";

export class PlannerRepository implements PlannerReadProvider {
  constructor(private readonly resolver: LiveDbSqlResolver) {}

  async getStarredTasks(input: { cursor?: string; limit: number }) {
    return await listStarredTasks(await this.resolver.resolveSql(), input);
  }

  async getDailyHistory(input: { before: string; limit: number }) {
    return await listDailyHistory(await this.resolver.resolveSql(), input);
  }

  async getToday(date: string): Promise<PlannerTodayDto | null> {
    const row = await this.read("today", date, {
      taskLimit: 1,
      documentLimit: 1,
      includeTasks: true,
      includeDocuments: false,
    });
    return row?.payload as PlannerTodayDto | null ?? null;
  }

  async getProject(pageId: string, input: { limit: number }): Promise<PlannerProjectDto | null> {
    return await this.readProject(pageId, {
      taskLimit: input.limit,
      documentLimit: input.limit,
      includeTasks: true,
      includeDocuments: true,
    });
  }

  async getProjectTasks(
    pageId: string,
    input: { cursor?: string; limit: number },
  ): Promise<PlannerPageSlice<PlannerTaskDto> | null> {
    const project = await this.readProject(pageId, {
      taskCursor: input.cursor,
      taskLimit: input.limit,
      documentLimit: 1,
      includeTasks: true,
      includeDocuments: false,
    });
    return project?.tasks ?? null;
  }

  async getProjectDocuments(
    pageId: string,
    input: { cursor?: string; limit: number },
  ): Promise<PlannerPageSlice<PlannerPageDto> | null> {
    const project = await this.readProject(pageId, {
      documentCursor: input.cursor,
      taskLimit: 1,
      documentLimit: input.limit,
      includeTasks: false,
      includeDocuments: true,
    });
    return project?.documents ?? null;
  }

  async getTaskRuns(
    pageId: string,
    input: { cursor?: string; limit: number },
  ): Promise<PlannerTaskRunPageDto | null> {
    return await listTaskRuns(await this.resolver.resolveSql(), pageId, input);
  }

  private async readProject(
    pageId: string,
    input: ProjectReadInput,
  ): Promise<PlannerProjectDto | null> {
    const row = await this.read("project", pageId, input);
    if (!row?.payload) return null;
    const payload = row.payload as RawPlannerProjectDto;
    return {
      project: payload.project,
      tasks: {
        items: payload.tasks,
        next_cursor: encodeMountCursor("task", nextMountCursor(row, "task")),
      },
      documents: {
        items: payload.documents,
        next_cursor: encodeMountCursor("document", nextMountCursor(row, "document")),
      },
    };
  }

  private async read(
    kind: PlannerKind,
    selector: string,
    input: ProjectReadInput,
  ): Promise<PlannerPayloadRow | null> {
    const sql = await this.resolver.resolveSql();
    const rows = await plannerQuery(sql, kind, selector, input);
    return rows[0] ?? null;
  }
}

function nextMountCursor(
  row: PlannerPayloadRow,
  kind: "task" | "document",
): PlannerMountCursor | null {
  const position = kind === "task" ? row.next_task_position : row.next_document_position;
  const id = kind === "task" ? row.next_task_id : row.next_document_id;
  return position && id ? { position, id } : null;
}
