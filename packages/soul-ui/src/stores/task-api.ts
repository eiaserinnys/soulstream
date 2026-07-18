import type {
  TaskOverviewPayload,
  TaskSnapshot,
  SetTaskItemStatusInput,
  SetTaskStatusInput,
} from "./task-store";
import type { TaskChecklistMutation } from "./task-mutations";
import { fetchWithProjectionRetry } from "../lib/projection-retry";

interface TaskItemStatusResponse {
  ok: boolean;
  snapshot?: TaskSnapshot;
}

interface TaskStatusResponse {
  ok: boolean;
  snapshot?: TaskSnapshot;
}

export interface TaskMutationResponse {
  ok: boolean;
  snapshot?: TaskSnapshot;
}

export class TaskApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "TaskApiError";
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function extractTaskErrorMessage(payload: unknown): string | null {
  if (typeof payload === "string") return nonEmptyString(payload);
  if (typeof payload !== "object" || payload === null) return null;

  const record = payload as Record<string, unknown>;
  const detail = record.detail;
  if (typeof detail === "object" && detail !== null) {
    const detailRecord = detail as Record<string, unknown>;
    const error = detailRecord.error;
    if (typeof error === "object" && error !== null) {
      const message = nonEmptyString((error as Record<string, unknown>).message);
      if (message) return message;
    }
    const detailMessage = nonEmptyString(detailRecord.message);
    if (detailMessage) return detailMessage;
  }
  const detailMessage = nonEmptyString(detail);
  if (detailMessage) return detailMessage;

  const error = record.error;
  if (typeof error === "object" && error !== null) {
    const message = nonEmptyString((error as Record<string, unknown>).message);
    if (message) return message;
  }
  const errorMessage = nonEmptyString(error);
  if (errorMessage) return errorMessage;

  return nonEmptyString(record.message);
}

async function readTaskErrorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  try {
    const payload = await response.json();
    return extractTaskErrorMessage(payload) ?? fallback;
  } catch {
    return fallback;
  }
}

export async function fetchTaskSnapshot(
  taskId: string,
  signal?: AbortSignal,
): Promise<TaskSnapshot | null> {
  const response = await fetchWithProjectionRetry(
    (requestSignal) => fetch(`/api/tasks/${encodeURIComponent(taskId)}`, {
      signal: requestSignal,
    }),
    signal,
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(await readTaskErrorMessage(
      response,
      `Task fetch failed: ${response.status}`,
    ));
  }
  return await response.json() as TaskSnapshot;
}

export async function fetchTaskOverview(
  signal?: AbortSignal,
): Promise<TaskOverviewPayload> {
  const response = await fetch("/api/tasks/my-turn", { signal });
  if (!response.ok) {
    throw new Error(await readTaskErrorMessage(
      response,
      `Task overview fetch failed: ${response.status}`,
    ));
  }
  return await response.json() as TaskOverviewPayload;
}

export async function postTaskItemStatus(
  input: SetTaskItemStatusInput,
): Promise<TaskItemStatusResponse> {
  const response = await fetch(
    `/api/tasks/${encodeURIComponent(input.taskId)}/items/${encodeURIComponent(input.itemId)}/status`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        status: input.status,
        expectedVersion: input.expectedVersion,
        idempotencyKey: input.idempotencyKey,
        ...(input.reason ? { reason: input.reason } : {}),
      }),
    },
  );
  if (!response.ok) {
    throw new TaskApiError(
      await readTaskErrorMessage(
        response,
        `Task status update failed: ${response.status}`,
      ),
      response.status,
    );
  }
  return await response.json() as TaskItemStatusResponse;
}

export async function postTaskStatus(
  input: SetTaskStatusInput,
): Promise<TaskStatusResponse> {
  const response = await fetch(
    `/api/tasks/${encodeURIComponent(input.taskId)}/status`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        status: input.status,
        expectedVersion: input.expectedVersion,
        idempotencyKey: input.idempotencyKey,
        ...(input.reason ? { reason: input.reason } : {}),
      }),
    },
  );
  if (!response.ok) {
    throw new Error(await readTaskErrorMessage(
      response,
      `Task status update failed: ${response.status}`,
    ));
  }
  return await response.json() as TaskStatusResponse;
}

export async function postTaskChecklistMutation(
  input: TaskChecklistMutation,
): Promise<TaskMutationResponse> {
  const request = mutationRequest(input);
  const response = await fetch(request.path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(request.body),
  });
  if (!response.ok) {
    throw new TaskApiError(
      await readTaskErrorMessage(
        response,
        `Task mutation failed: ${response.status}`,
      ),
      response.status,
    );
  }
  return await response.json() as TaskMutationResponse;
}

function mutationRequest(input: TaskChecklistMutation): {
  path: string;
  body: Record<string, unknown>;
} {
  const task = encodeURIComponent(input.taskId);
  const common = { idempotencyKey: input.idempotencyKey };
  const versioned = "expectedVersion" in input
    ? {
        ...common,
        expectedVersion: input.expectedVersion,
        ...(input.reason ? { reason: input.reason } : {}),
      }
    : common;

  switch (input.kind) {
    case "create_section":
      return {
        path: `/api/tasks/${task}/sections`,
        body: {
          ...common,
          sectionId: input.sectionId,
          title: input.title,
          ...(input.afterSectionId ? { afterSectionId: input.afterSectionId } : {}),
          ...(input.beforeSectionId ? { beforeSectionId: input.beforeSectionId } : {}),
        },
      };
    case "update_section":
      return {
        path: `/api/tasks/${task}/sections/${encodeURIComponent(input.sectionId)}`,
        body: { ...versioned, title: input.title },
      };
    case "move_section":
      return {
        path: `/api/tasks/${task}/sections/${encodeURIComponent(input.sectionId)}/move`,
        body: {
          ...versioned,
          ...(input.afterSectionId ? { afterSectionId: input.afterSectionId } : {}),
          ...(input.beforeSectionId ? { beforeSectionId: input.beforeSectionId } : {}),
        },
      };
    case "archive_section":
      return {
        path: `/api/tasks/${task}/sections/${encodeURIComponent(input.sectionId)}/archive`,
        body: versioned,
      };
    case "create_item":
      return {
        path: `/api/tasks/${task}/sections/${encodeURIComponent(input.sectionId)}/items`,
        body: {
          ...common,
          itemId: input.itemId,
          title: input.title,
          howTo: input.howTo ?? "",
          ...(input.afterItemId ? { afterItemId: input.afterItemId } : {}),
          ...(input.beforeItemId ? { beforeItemId: input.beforeItemId } : {}),
        },
      };
    case "update_item":
      return {
        path: `/api/tasks/${task}/items/${encodeURIComponent(input.itemId)}`,
        body: {
          ...versioned,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.howTo === undefined ? {} : { howTo: input.howTo }),
        },
      };
    case "move_item":
      return {
        path: `/api/tasks/${task}/items/${encodeURIComponent(input.itemId)}/move`,
        body: {
          ...versioned,
          sectionId: input.sectionId,
          ...(input.afterItemId ? { afterItemId: input.afterItemId } : {}),
          ...(input.beforeItemId ? { beforeItemId: input.beforeItemId } : {}),
        },
      };
    case "archive_item":
      return {
        path: `/api/tasks/${task}/items/${encodeURIComponent(input.itemId)}/archive`,
        body: versioned,
      };
  }
}
