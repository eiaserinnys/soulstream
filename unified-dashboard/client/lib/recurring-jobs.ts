import type { useTranslation } from "react-i18next";
import { HttpResponseError } from "./http-response-error";

export type RecurringJobEventTrigger = {
  type: "node_connected";
  node_id: string;
  settle_seconds: number;
  cooldown_seconds: number;
  repeat: boolean;
};

export type RecurringJob = {
  job_id: string;
  name: string;
  prompt: string;
  timezone: string;
  schedule_kind: "recurring" | "once" | "event";
  run_at: string | null;
  /** Absent from older payloads; the server always sends it now. */
  event_trigger?: RecurringJobEventTrigger | null;
  event_last_fired_at?: string | null;
  schedule_expressions: string[];
  node_id: string;
  agent_id: string;
  model_preset: string | null;
  folderId: string;
  enabled: boolean;
  archived_at: string | null;
  late_run_window_seconds: number;
  next_run_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};

export function recurringJobConditionText(
  job: Pick<RecurringJob, "node_id" | "event_trigger">,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  const nodeId = job.event_trigger?.node_id ?? job.node_id;
  return t("jobs.recurring.connectionTrigger", { node: nodeId, frequency: job.event_trigger?.repeat ? t("jobs.recurring.everyConnection") : t("jobs.schedule.once") });
}

export type RecurringJobRun = {
  run_id: string;
  job_id: string;
  trigger: "scheduled" | "manual" | "event";
  scheduled_for: string | null;
  session_id: string;
  state: string;
  reason_code: string | null;
  reason_message: string | null;
  job_snapshot: Record<string, unknown>;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
};

export type RecurringJobWrite = {
  name: string;
  prompt: string;
  timezone: string;
  schedule_expressions?: string[];
  run_at?: string;
  node_id: string;
  agent_id: string;
  model_preset: string | null;
  folderId: string;
  late_run_window_seconds?: number;
  enabled?: boolean;
};

export async function listRecurringJobs(includeArchived = false): Promise<RecurringJob[]> {
  const query = includeArchived ? "?include_archived=true" : "";
  const response = await request(`/api/recurring-jobs${query}`);
  return (await response.json() as { jobs: RecurringJob[] }).jobs;
}

export async function previewRecurringSchedule(input: {
  timezone: string;
  schedule_expressions: string[];
}): Promise<{ timezone: string; scheduleExpressions: string[]; nextRuns: string[] }> {
  const response = await request("/api/recurring-jobs/preview", { method: "POST", body: input });
  return await response.json() as { timezone: string; scheduleExpressions: string[]; nextRuns: string[] };
}

export async function createRecurringJob(input: RecurringJobWrite & { idempotency_key: string }): Promise<RecurringJob> {
  const response = await request("/api/recurring-jobs", { method: "POST", body: input });
  return (await response.json() as { job: RecurringJob }).job;
}

export async function updateRecurringJob(
  jobId: string,
  input: Partial<RecurringJobWrite> & { expected_version: number; enabled?: boolean },
): Promise<RecurringJob> {
  const response = await request(`/api/recurring-jobs/${encodeURIComponent(jobId)}`, { method: "PATCH", body: input });
  return (await response.json() as { job: RecurringJob }).job;
}

export async function runRecurringJob(jobId: string, idempotencyKey: string): Promise<RecurringJobRun> {
  const response = await request(`/api/recurring-jobs/${encodeURIComponent(jobId)}/run`, {
    method: "POST",
    body: { idempotency_key: idempotencyKey },
  });
  return (await response.json() as { run: RecurringJobRun }).run;
}

export async function archiveRecurringJob(jobId: string, expectedVersion: number): Promise<RecurringJob> {
  const response = await request(`/api/recurring-jobs/${encodeURIComponent(jobId)}/archive`, {
    method: "POST",
    body: { expected_version: expectedVersion },
  });
  return (await response.json() as { job: RecurringJob }).job;
}

export async function listRecurringJobRuns(jobId: string): Promise<RecurringJobRun[]> {
  const response = await request(`/api/recurring-jobs/${encodeURIComponent(jobId)}/runs?limit=50`);
  return (await response.json() as { runs: RecurringJobRun[] }).runs;
}

async function request(
  path: string,
  options: { method?: "POST" | "PATCH"; body?: unknown } = {},
): Promise<Response> {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    credentials: "same-origin",
    headers: options.body === undefined ? { Accept: "application/json" } : {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  if (response.ok) return response;
  const message = await errorMessage(response);
  if (message !== undefined) throw new HttpResponseError(message, response.status);
  throw new RecurringJobRequestError(response.status);
}

export class RecurringJobRequestError extends HttpResponseError {
  constructor(status: number) {
    super(`HTTP ${status}`, status);
  }
}

async function errorMessage(response: Response): Promise<string | undefined> {
  try {
    const payload = await response.json() as {
      detail?: { error?: { message?: unknown } } | string;
      error?: { message?: unknown } | string;
    };
    if (typeof payload.detail === "string") return payload.detail;
    if (typeof payload.detail?.error?.message === "string") return payload.detail.error.message;
    if (typeof payload.error === "string") return payload.error;
    if (typeof payload.error?.message === "string") return payload.error.message;
  } catch {
  }
  return undefined;
}
