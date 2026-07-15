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
  /** Creates the execution and document aspects of one task identity. */
  createTaskIdentity(input: { title: string; description: string; folderId: string }): Promise<{ id: string }>;
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

const CREATION_ERROR_LABEL: Record<PlannerTaskCreationPhase, string> = {
  page: "업무 페이지 생성",
  runbook: "런북 생성",
  reference: "업무-런북 연결",
  project_mount: "프로젝트 편입",
};

export function plannerTaskCreationErrorLabel(error: unknown): string {
  return error instanceof PlannerTaskCreationError
    ? CREATION_ERROR_LABEL[error.phase]
    : "새 업무 생성";
}

export async function createPlannerTask(
  input: PlannerTaskCreationInput,
  port: PlannerTaskCreationPort,
): Promise<{ pageId: string; runbookId: string }> {
  const identity = await runPhase("runbook", () => port.createTaskIdentity({
    title: input.title,
    description: input.description,
    folderId: input.folderId,
  }));
  await runPhase("page", () => port.mountPage({
    sourcePageId: input.dailyPageId,
    title: input.title,
  }));
  await runPhase("project_mount", () => port.mountPage({
    sourcePageId: input.projectPageId,
    title: input.title,
  }));
  return { pageId: identity.id, runbookId: identity.id };
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
