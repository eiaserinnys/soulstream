import type { InitialFolderContext } from "@seosoyoung/soul-ui/page";

export type PlannerFolderCreationPhase =
  | "page"
  | "folder"
  | "reference";

export interface PlannerFolderCreationInput {
  title: string;
  description: string;
  dailyPageId: string;
  folderId: string;
  initialContext?: InitialFolderContext;
}

export interface PlannerFolderCreationPort {
  /** Creates the folder and its bound page. */
  createFolderIdentity(input: {
    title: string;
    description: string;
    folderId: string;
    initialContext?: InitialFolderContext;
  }): Promise<{ id: string; pageId: string }>;
  mountPage(input: { sourcePageId: string; title: string }): Promise<void>;
}

export class PlannerFolderCreationError extends Error {
  readonly name = "PlannerFolderCreationError";

  constructor(
    readonly phase: PlannerFolderCreationPhase,
    readonly cause: unknown,
  ) {
    super(errorMessage(cause));
  }
}

const CREATION_ERROR_LABEL: Record<PlannerFolderCreationPhase, string> = {
  page: "업무 페이지 생성",
  folder: "업무 생성",
  reference: "업무 연결",
};

export function plannerFolderCreationErrorLabel(error: unknown): string {
  return error instanceof PlannerFolderCreationError
    ? CREATION_ERROR_LABEL[error.phase]
    : "새 업무 생성";
}

export async function createPlannerFolder(
  input: PlannerFolderCreationInput,
  port: PlannerFolderCreationPort,
): Promise<{ pageId: string; folderId: string }> {
  const identity = await runPhase("folder", () => port.createFolderIdentity({
    title: input.title,
    description: input.description,
    folderId: input.folderId,
    ...(input.initialContext ? { initialContext: input.initialContext } : {}),
  }));
  await runPhase("page", () => port.mountPage({
    sourcePageId: input.dailyPageId,
    title: input.title,
  }));
  return { pageId: identity.pageId, folderId: identity.id };
}

async function runPhase<T>(phase: PlannerFolderCreationPhase, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new PlannerFolderCreationError(phase, error);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
