export type PlannerTaskCreationPhase =
  | "page"
  | "runbook"
  | "reference"
  | "project_mount";

export interface PlannerTaskCreationInput {
  title: string;
  description: string;
  dailyPageId: string;
  projectPageId: string;
  folderId: string;
}

export interface PlannerTaskCreationPort {
  /** Creates the task page and atomically leaves its first mount on the daily page. */
  createTaskPage(input: { title: string; description: string; sourcePageId: string }): Promise<{ pageId: string }>;
  createRunbook(input: { title: string; folderId: string }): Promise<{ runbookId: string }>;
  addPrimaryRunbookReference(input: { pageId: string; runbookId: string }): Promise<void>;
  mountPage(input: { sourcePageId: string; title: string }): Promise<void>;
}

export class PlannerTaskCreationError extends Error {
  readonly name = "PlannerTaskCreationError";

  constructor(
    readonly phase: PlannerTaskCreationPhase,
    readonly cause: unknown,
  ) {
    super(errorMessage(cause));
  }
}

export async function createPlannerTask(
  input: PlannerTaskCreationInput,
  port: PlannerTaskCreationPort,
): Promise<{ pageId: string; runbookId: string }> {
  const page = await runPhase("page", () => port.createTaskPage({
    title: input.title,
    description: input.description,
    sourcePageId: input.dailyPageId,
  }));
  const runbook = await runPhase("runbook", () => port.createRunbook({
    title: input.title,
    folderId: input.folderId,
  }));
  await runPhase("reference", () => port.addPrimaryRunbookReference({
    pageId: page.pageId,
    runbookId: runbook.runbookId,
  }));
  await runPhase("project_mount", () => port.mountPage({
    sourcePageId: input.projectPageId,
    title: input.title,
  }));
  return { pageId: page.pageId, runbookId: runbook.runbookId };
}

async function runPhase<T>(phase: PlannerTaskCreationPhase, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new PlannerTaskCreationError(phase, error);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
