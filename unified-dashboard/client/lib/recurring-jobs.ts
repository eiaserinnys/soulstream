import { HttpResponseError } from "./http-response-error";

export type RecurringJobContainer = { kind: "folder" | "task"; id: string };

export type RecurringJob = {
  job_id: string;
  name: string;
  prompt: string;
  timezone: string;
  schedule_expressions: string[];
  node_id: string;
  agent_id: string;
  model_preset: string | null;
  container: RecurringJobContainer;
  folder_id: string;
  enabled: boolean;
  archived_at: string | null;
  late_run_window_seconds: number;
  next_run_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};

export type RecurringJobRun = {
  run_id: string;
  job_id: string;
  trigger: "scheduled" | "manual";
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
  schedule_expressions: string[];
  node_id: string;
  agent_id: string;
  model_preset: string | null;
  container: RecurringJobContainer;
  folder_id: string;
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
  throw new HttpResponseError(await errorMessage(response), response.status);
}

async function errorMessage(response: Response): Promise<string> {
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
    // A compact status below is more useful than an unreadable server body.
  }
  return `반복 작업 요청 실패 (${response.status})`;
}
