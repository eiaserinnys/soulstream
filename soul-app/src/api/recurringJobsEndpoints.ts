import type { ApiRequestContext } from './clientCore';

export interface RecurringJobDto {
  job_id: string;
  name: string;
  prompt: string;
  timezone: string;
  schedule_expressions: string[];
  node_id: string;
  agent_id: string;
  model_preset: string | null;
  folder_id: string;
  enabled: boolean;
  archived_at: string | null;
  late_run_window_seconds: number;
  next_run_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface RecurringJobRunDto {
  run_id: string;
  job_id: string;
  trigger: 'scheduled' | 'manual';
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
}

export interface RecurringJobWrite {
  name: string;
  prompt: string;
  timezone: string;
  schedule_expressions: string[];
  node_id: string;
  agent_id: string;
  model_preset: string | null;
  folder_id: string;
  late_run_window_seconds?: number;
  enabled?: boolean;
}

export function createRecurringJobsEndpoints({
  base,
  authFetch,
  readJson,
  buildQuery,
}: ApiRequestContext) {
  const root = `${base}/api/recurring-jobs`;
  return {
    listRecurringJobs: async (includeArchived = false): Promise<{ jobs: RecurringJobDto[] }> => {
      const query = includeArchived ? `?${buildQuery({ include_archived: true })}` : '';
      return await authFetch(`${root}${query}`).then((response) => readJson(response, 'listRecurringJobs'));
    },
    previewRecurringSchedule: (input: { timezone: string; schedule_expressions: string[] }): Promise<{
      timezone: string;
      scheduleExpressions: string[];
      nextRuns: string[];
    }> => authFetch(`${root}/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }).then((response) => readJson(response, 'previewRecurringSchedule')),
    createRecurringJob: (input: RecurringJobWrite & { idempotency_key: string }): Promise<{ job: RecurringJobDto }> =>
      authFetch(root, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
      }).then((response) => readJson(response, 'createRecurringJob')),
    updateRecurringJob: (jobId: string, input: Partial<RecurringJobWrite> & {
      expected_version: number;
      enabled?: boolean;
    }): Promise<{ job: RecurringJobDto }> => authFetch(`${root}/${encodeURIComponent(jobId)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    }).then((response) => readJson(response, 'updateRecurringJob')),
    runRecurringJob: (jobId: string, idempotencyKey: string): Promise<{ run: RecurringJobRunDto }> =>
      authFetch(`${root}/${encodeURIComponent(jobId)}/run`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idempotency_key: idempotencyKey }),
      }).then((response) => readJson(response, 'runRecurringJob')),
    archiveRecurringJob: (jobId: string, expectedVersion: number): Promise<{ job: RecurringJobDto }> =>
      authFetch(`${root}/${encodeURIComponent(jobId)}/archive`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expected_version: expectedVersion }),
      }).then((response) => readJson(response, 'archiveRecurringJob')),
    listRecurringJobRuns: (jobId: string): Promise<{ runs: RecurringJobRunDto[] }> =>
      authFetch(`${root}/${encodeURIComponent(jobId)}/runs?limit=50`)
        .then((response) => readJson(response, 'listRecurringJobRuns')),
  };
}
