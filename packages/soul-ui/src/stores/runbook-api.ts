import type {
  RunbookOverviewPayload,
  RunbookSnapshot,
  SetRunbookItemStatusInput,
  SetRunbookStatusInput,
} from "./runbook-store";

interface RunbookItemStatusResponse {
  ok: boolean;
  snapshot?: RunbookSnapshot;
}

interface RunbookStatusResponse {
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
  const response = await fetch(`/api/runbooks/${encodeURIComponent(runbookId)}`, {
    signal,
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(await readRunbookErrorMessage(
      response,
      `Runbook fetch failed: ${response.status}`,
    ));
  }
  return await response.json() as RunbookSnapshot;
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
