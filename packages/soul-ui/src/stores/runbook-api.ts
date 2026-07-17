import type {
  RunbookOverviewPayload,
  RunbookSnapshot,
  SetRunbookItemStatusInput,
  SetRunbookStatusInput,
} from "./runbook-store";
import type { RunbookChecklistMutation } from "./runbook-mutations";

interface RunbookItemStatusResponse {
  ok: boolean;
  snapshot?: RunbookSnapshot;
}

interface RunbookStatusResponse {
  ok: boolean;
  snapshot?: RunbookSnapshot;
}

export interface RunbookMutationResponse {
  ok: boolean;
  snapshot?: RunbookSnapshot;
}

export class RunbookApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "RunbookApiError";
  }
}

const RUNBOOK_PROJECTION_RETRY_DELAYS_MS = [100, 250, 500] as const;

function waitForProjection(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function extractRunbookErrorMessage(payload: unknown): string | null {
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

async function readRunbookErrorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  try {
    const payload = await response.json();
    return extractRunbookErrorMessage(payload) ?? fallback;
  } catch {
    return fallback;
  }
}

export async function fetchRunbookSnapshot(
  runbookId: string,
  signal?: AbortSignal,
): Promise<RunbookSnapshot | null> {
  for (let attempt = 0; attempt <= RUNBOOK_PROJECTION_RETRY_DELAYS_MS.length; attempt += 1) {
    const response = await fetch(`/api/runbooks/${encodeURIComponent(runbookId)}`, {
      signal,
    });
    if (response.status !== 404) {
      if (!response.ok) {
        throw new Error(await readRunbookErrorMessage(
          response,
          `Runbook fetch failed: ${response.status}`,
        ));
      }
      return await response.json() as RunbookSnapshot;
    }
    const retryDelay = RUNBOOK_PROJECTION_RETRY_DELAYS_MS[attempt];
    if (retryDelay === undefined) return null;
    await waitForProjection(retryDelay, signal);
  }
  return null;
}

export async function fetchRunbookOverview(
  signal?: AbortSignal,
): Promise<RunbookOverviewPayload> {
  const response = await fetch("/api/runbooks/my-turn", { signal });
  if (!response.ok) {
    throw new Error(await readRunbookErrorMessage(
      response,
      `Runbook overview fetch failed: ${response.status}`,
    ));
  }
  return await response.json() as RunbookOverviewPayload;
}

export async function postRunbookItemStatus(
  input: SetRunbookItemStatusInput,
): Promise<RunbookItemStatusResponse> {
  const response = await fetch(
    `/api/runbooks/${encodeURIComponent(input.runbookId)}/items/${encodeURIComponent(input.itemId)}/status`,
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
    throw new RunbookApiError(
      await readRunbookErrorMessage(
        response,
        `Runbook status update failed: ${response.status}`,
      ),
      response.status,
    );
  }
  return await response.json() as RunbookItemStatusResponse;
}

export async function postRunbookStatus(
  input: SetRunbookStatusInput,
): Promise<RunbookStatusResponse> {
  const response = await fetch(
    `/api/runbooks/${encodeURIComponent(input.runbookId)}/status`,
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
    throw new Error(await readRunbookErrorMessage(
      response,
      `Runbook status update failed: ${response.status}`,
    ));
  }
  return await response.json() as RunbookStatusResponse;
}

export async function postRunbookChecklistMutation(
  input: RunbookChecklistMutation,
): Promise<RunbookMutationResponse> {
  const request = mutationRequest(input);
  const response = await fetch(request.path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(request.body),
  });
  if (!response.ok) {
    throw new RunbookApiError(
      await readRunbookErrorMessage(
        response,
        `Runbook mutation failed: ${response.status}`,
      ),
      response.status,
    );
  }
  return await response.json() as RunbookMutationResponse;
}

function mutationRequest(input: RunbookChecklistMutation): {
  path: string;
  body: Record<string, unknown>;
} {
  const runbook = encodeURIComponent(input.runbookId);
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
        path: `/api/runbooks/${runbook}/sections`,
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
        path: `/api/runbooks/${runbook}/sections/${encodeURIComponent(input.sectionId)}`,
        body: { ...versioned, title: input.title },
      };
    case "move_section":
      return {
        path: `/api/runbooks/${runbook}/sections/${encodeURIComponent(input.sectionId)}/move`,
        body: {
          ...versioned,
          ...(input.afterSectionId ? { afterSectionId: input.afterSectionId } : {}),
          ...(input.beforeSectionId ? { beforeSectionId: input.beforeSectionId } : {}),
        },
      };
    case "archive_section":
      return {
        path: `/api/runbooks/${runbook}/sections/${encodeURIComponent(input.sectionId)}/archive`,
        body: versioned,
      };
    case "create_item":
      return {
        path: `/api/runbooks/${runbook}/sections/${encodeURIComponent(input.sectionId)}/items`,
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
        path: `/api/runbooks/${runbook}/items/${encodeURIComponent(input.itemId)}`,
        body: {
          ...versioned,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.howTo === undefined ? {} : { howTo: input.howTo }),
        },
      };
    case "move_item":
      return {
        path: `/api/runbooks/${runbook}/items/${encodeURIComponent(input.itemId)}/move`,
        body: {
          ...versioned,
          sectionId: input.sectionId,
          ...(input.afterItemId ? { afterItemId: input.afterItemId } : {}),
          ...(input.beforeItemId ? { beforeItemId: input.beforeItemId } : {}),
        },
      };
    case "archive_item":
      return {
        path: `/api/runbooks/${runbook}/items/${encodeURIComponent(input.itemId)}/archive`,
        body: versioned,
      };
  }
}
