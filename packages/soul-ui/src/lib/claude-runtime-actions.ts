import type {
  ClaudeRuntimeModeView,
  ClaudeRuntimeNotificationView,
  ClaudeRuntimeRemoteTriggerView,
  ClaudeRuntimeScheduleView,
  ClaudeRuntimeTaskView,
  ClaudeRuntimeTranscriptMirrorView,
} from "../stores/claude-runtime-state";

export interface ClaudeRuntimeTasksResponse {
  sessionId: string;
  sessionState: "idle" | "running" | "requires_action" | null;
  runtimeSessionId: string | null;
  updatedAt: number | null;
  tasks: ClaudeRuntimeTaskView[];
  notifications?: ClaudeRuntimeNotificationView[];
  remoteTriggers?: ClaudeRuntimeRemoteTriggerView[];
  transcriptMirror?: ClaudeRuntimeTranscriptMirrorView | null;
  planMode?: ClaudeRuntimeModeView | null;
  worktreeMode?: ClaudeRuntimeModeView | null;
}

export interface ClaudeRuntimeTaskOutputResponse {
  sessionId: string;
  taskId: string;
  task: ClaudeRuntimeTaskView | null;
  output: string;
  outputAvailable: boolean;
  truncated: boolean;
  message?: string;
}

export interface ClaudeRuntimeStopTaskResponse {
  sessionId: string;
  taskId: string;
  supported: boolean;
  stopped: boolean;
  alreadyTerminal: boolean;
  status?: string;
  message?: string;
  task: ClaudeRuntimeTaskView | null;
}

export interface ClaudeRuntimeSchedulesResponse {
  sessionId: string;
  nextRunAt: string | null;
  schedules: ClaudeRuntimeScheduleView[];
}

export interface ClaudeRuntimeDeleteScheduleResponse {
  sessionId: string;
  scheduleId: string;
  status: string;
  deleted: boolean;
  schedule: ClaudeRuntimeScheduleView | null;
}

export interface ResumeAfterLimitScheduleView {
  schedule_id: string;
  run_at: string;
  status: string;
}

export interface ResumeAfterLimitEligibilityResponse {
  eligible: boolean;
  reason: string | null;
  resets_at: string | null;
  schedule: ResumeAfterLimitScheduleView | null;
}

export interface ResumeAfterLimitScheduleResponse extends ResumeAfterLimitScheduleView {
  reused: boolean;
}

export async function listClaudeBackgroundTasks(
  sessionId: string,
): Promise<ClaudeRuntimeTasksResponse> {
  const response = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/background-tasks`,
  );
  if (!response.ok) throw new Error(await response.text());
  return await response.json() as ClaudeRuntimeTasksResponse;
}

export async function getClaudeBackgroundTaskOutput(
  sessionId: string,
  taskId: string,
): Promise<ClaudeRuntimeTaskOutputResponse> {
  const response = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/background-tasks/${encodeURIComponent(taskId)}/output`,
  );
  if (!response.ok) throw new Error(await response.text());
  return await response.json() as ClaudeRuntimeTaskOutputResponse;
}

export async function stopClaudeBackgroundTask(
  sessionId: string,
  taskId: string,
): Promise<ClaudeRuntimeStopTaskResponse> {
  const response = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/background-tasks/${encodeURIComponent(taskId)}/stop`,
    { method: "POST" },
  );
  if (!response.ok) throw new Error(await response.text());
  return await response.json() as ClaudeRuntimeStopTaskResponse;
}

export async function listClaudeSchedules(
  sessionId: string,
): Promise<ClaudeRuntimeSchedulesResponse> {
  const response = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/schedules`,
  );
  if (!response.ok) throw new Error(await response.text());
  return await response.json() as ClaudeRuntimeSchedulesResponse;
}

export async function deleteClaudeSchedule(
  sessionId: string,
  scheduleId: string,
): Promise<ClaudeRuntimeDeleteScheduleResponse> {
  const response = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/schedules/${encodeURIComponent(scheduleId)}`,
    { method: "DELETE" },
  );
  if (!response.ok) throw new Error(await response.text());
  return await response.json() as ClaudeRuntimeDeleteScheduleResponse;
}

export async function getResumeAfterLimitEligibility(
  sessionId: string,
): Promise<ResumeAfterLimitEligibilityResponse> {
  const response = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/resume-after-limit`,
  );
  if (!response.ok) throw new Error(await response.text());
  return await response.json() as ResumeAfterLimitEligibilityResponse;
}

export async function scheduleResumeAfterLimit(
  sessionId: string,
): Promise<ResumeAfterLimitScheduleResponse> {
  const response = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/resume-after-limit`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    },
  );
  if (!response.ok) throw new Error(await response.text());
  return await response.json() as ResumeAfterLimitScheduleResponse;
}
