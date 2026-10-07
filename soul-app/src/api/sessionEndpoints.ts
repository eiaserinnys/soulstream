import type { ApiRequestContext } from './clientCore';
import type {
  ClaudeRuntimeTaskOutputResponse,
  ClaudeRuntimeTasksResponse,
  ClaudeRuntimeDeleteScheduleResponse,
  ClaudeRuntimeSchedulesResponse,
  ClaudeRuntimeStopTaskResponse,
  InterveneResponse,
} from './types';
import type { MessagesResponse, ToolTraceResponse } from './historyTypes';
import { useAuthStore } from '../store/authStore';
import { decodeAuthJwt } from '../auth/jwt-payload';
import { buildSoulAppCallerInfo } from '../auth/caller-info';
import { appendAttachmentPathNotes } from '../utils/attachmentPathNotes';
import { parseReviewAcknowledgeResponse } from './reviewAcknowledge';

export interface CreateSessionRequest {
  prompt: string;
  folderId?: string;
  agentId?: string;
  nodeId?: string;
  modelPreset?: string;
  /**
   * Requested reasoning effort. Omit to let the node apply the selected preset's
   * advertised default. The node validates it against that preset.
   */
  reasoningEffort?: string;
  attachmentPaths?: string[];
  cardId?: string;
  pageAnchor?: { pageId: string; blockId: string; expectedVersion: number };
  predecessorSessionId?: string;
  extraContextItems?: Array<{ key: string; label?: string; content: unknown }>;
}

export interface CreateSessionResponse {
  agentSessionId?: string;
  [key: string]: unknown;
}

export interface SessionStoryTurnSummary {
  event_id: number;
  turn_number: number;
  content: string;
  turn_start_event_id: number | null;
  final_response_event_id: number | null;
  created_at: string;
  [key: string]: unknown;
}

export interface SessionStoryResponse {
  highlight: string | null;
  narrative: string | null;
  unfolded_turn_summaries: SessionStoryTurnSummary[];
  narrative_through_event_id: number | null;
  fold_count: number;
  updated_at: string | null;
  [key: string]: unknown;
}

export interface ResumeAfterLimitSchedule {
  schedule_id: string;
  run_at: string;
  status: string;
}

export interface ResumeAfterLimitResponse {
  eligible: boolean;
  reason: string | null;
  resets_at: string | null;
  schedule: ResumeAfterLimitSchedule | null;
}

export interface ScheduleResumeAfterLimitResponse {
  schedule_id: string;
  run_at: string;
  status: string;
  reused: boolean;
}

export function createSessionEndpoints({
  base,
  authFetch,
  readJson,
  buildQuery,
}: ApiRequestContext) {
  return {
    getSessionStory: async (
      sessionId: string,
    ): Promise<SessionStoryResponse | null> => {
      const response = await authFetch(
        `${base}/api/sessions/${encodeURIComponent(sessionId)}/story`,
      );
      if (response.status === 404) return null;
      return readJson<SessionStoryResponse>(response, 'getSessionStory');
    },

    // 세션 과거 메시지 페이지네이션 조회.
    getMessages: (
      sessionId: string,
      params?: { before?: string; limit?: number; signal?: AbortSignal },
    ): Promise<MessagesResponse> => {
      const { signal, ...queryParams } = params ?? {};
      const qs = buildQuery(queryParams);
      return authFetch(
        `${base}/api/sessions/${sessionId}/messages${qs ? `?${qs}` : ''}`,
        signal ? { signal } : undefined,
      ).then((r) => readJson(r, 'getMessages'));
    },

    // 기본 timeline은 비가시 이벤트를 제외하고, debugKinds가 있으면 서버가 고른 debug 이벤트를 더한다.
    getTimeline: (
      sessionId: string,
      params?: { before?: string; limit?: number; signal?: AbortSignal; eventTypes?: string[]; debugKinds?: string[] },
    ): Promise<MessagesResponse> => {
      const { signal, eventTypes, debugKinds, ...queryParams } = params ?? {};
      const query = {
        ...queryParams,
        ...(eventTypes === undefined ? {} : { event_types: eventTypes.join(",") }),
      };
      const search = new URLSearchParams(buildQuery(query));
      debugKinds?.forEach((kind) => search.append('debug_kinds', kind));
      const qs = search.toString();
      return authFetch(
        `${base}/api/sessions/${sessionId}/timeline${qs ? `?${qs}` : ''}`,
        signal ? { signal } : undefined,
      ).then((r) => readJson(r, 'getTimeline'));
    },

    getTimelineTrace: (
      sessionId: string,
      timelineId: string,
      params?: { signal?: AbortSignal },
    ): Promise<ToolTraceResponse> =>
      authFetch(
        `${base}/api/sessions/${sessionId}/timeline/${encodeURIComponent(timelineId)}/trace`,
        params?.signal ? { signal: params.signal } : undefined,
      ).then((r) => readJson(r, 'getTimelineTrace')),

    // caller_info는 client 내부에서 자동 조립한다.
    createSession: (body: CreateSessionRequest): Promise<CreateSessionResponse> => {
      const profile = decodeAuthJwt(useAuthStore.getState().jwt);
      const caller_info = buildSoulAppCallerInfo(profile);
      const prompt = appendAttachmentPathNotes(body.prompt, body.attachmentPaths);
      return authFetch(`${base}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...body,
          prompt,
          caller_info,
          ...(body.predecessorSessionId
            ? { predecessor_session_id: body.predecessorSessionId }
            : {}),
          ...(body.modelPreset ? { model_preset: body.modelPreset } : {}),
          ...(body.extraContextItems?.length
            ? { extra_context_items: body.extraContextItems }
            : {}),
          predecessorSessionId: undefined,
          modelPreset: undefined,
          extraContextItems: undefined,
        }),
      }).then((r) => readJson(r, 'createSession'));
    },

    renameSession: (sessionId: string, displayName: string | null): Promise<Response> =>
      authFetch(
        `${base}/api/sessions/${encodeURIComponent(sessionId)}/display-name`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ displayName }),
        },
      ).then(async (response) => {
        if (!response.ok) await readJson(response, 'renameSession');
        return response;
      }),

    deleteSession: (sessionId: string): Promise<Response> =>
      authFetch(`${base}/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
      }).then(async (response) => {
        if (!response.ok) await readJson(response, 'deleteSession');
        return response;
      }),

    intervene: (
      sessionId: string,
      text: string,
      attachmentPaths?: string[],
    ): Promise<InterveneResponse> => {
      const profile = decodeAuthJwt(useAuthStore.getState().jwt);
      const caller_info = buildSoulAppCallerInfo(profile);
      const messageText = appendAttachmentPathNotes(text, attachmentPaths);
      return authFetch(`${base}/api/sessions/${sessionId}/intervene`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: messageText,
          user: 'soul-app',
          caller_info,
          ...(attachmentPaths && attachmentPaths.length > 0
            ? { attachmentPaths }
            : {}),
        }),
      }).then((response) => readJson<InterveneResponse>(response, 'intervene'));
    },

    respond: (
      sessionId: string,
      requestId: string,
      answers: Record<string, string>,
    ): Promise<Response> =>
      authFetch(`${base}/api/sessions/${encodeURIComponent(sessionId)}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request_id: requestId, answers }),
      }),

    approveTool: (
      sessionId: string,
      approvalId: string,
      body?: { message?: string; alwaysApprove?: boolean },
    ): Promise<Response> =>
      authFetch(
        `${base}/api/sessions/${encodeURIComponent(sessionId)}/tool-approvals/${encodeURIComponent(approvalId)}/approve`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        },
      ),

    rejectTool: (
      sessionId: string,
      approvalId: string,
      body?: { message?: string; alwaysReject?: boolean },
    ): Promise<Response> =>
      authFetch(
        `${base}/api/sessions/${encodeURIComponent(sessionId)}/tool-approvals/${encodeURIComponent(approvalId)}/reject`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        },
      ),

    interruptSession: (sessionId: string): Promise<Response> =>
      authFetch(`${base}/api/sessions/${encodeURIComponent(sessionId)}/interrupt`, {
        method: 'POST',
      }),

    acknowledgeSessionReview: (sessionId: string) =>
      authFetch(
        `${base}/api/sessions/${encodeURIComponent(sessionId)}/review/acknowledge`,
        { method: 'POST', credentials: 'same-origin' },
      ).then(parseReviewAcknowledgeResponse),

    listClaudeBackgroundTasks: (
      sessionId: string,
    ): Promise<ClaudeRuntimeTasksResponse> =>
      authFetch(
        `${base}/api/sessions/${encodeURIComponent(sessionId)}/background-tasks`,
      ).then((r) => readJson(r, 'listClaudeBackgroundTasks')),

    getClaudeBackgroundTaskOutput: (
      sessionId: string,
      taskId: string,
    ): Promise<ClaudeRuntimeTaskOutputResponse> =>
      authFetch(
        `${base}/api/sessions/${encodeURIComponent(sessionId)}/background-tasks/${encodeURIComponent(taskId)}/output`,
      ).then((r) => readJson(r, 'getClaudeBackgroundTaskOutput')),

    stopClaudeBackgroundTask: (
      sessionId: string,
      taskId: string,
    ): Promise<ClaudeRuntimeStopTaskResponse> =>
      authFetch(
        `${base}/api/sessions/${encodeURIComponent(sessionId)}/background-tasks/${encodeURIComponent(taskId)}/stop`,
        { method: 'POST' },
      ).then((r) => readJson(r, 'stopClaudeBackgroundTask')),

    listClaudeSchedules: (
      sessionId: string,
    ): Promise<ClaudeRuntimeSchedulesResponse> =>
      authFetch(
        `${base}/api/sessions/${encodeURIComponent(sessionId)}/schedules`,
      ).then((r) => readJson(r, 'listClaudeSchedules')),

    deleteClaudeSchedule: (
      sessionId: string,
      scheduleId: string,
    ): Promise<ClaudeRuntimeDeleteScheduleResponse> =>
      authFetch(
        `${base}/api/sessions/${encodeURIComponent(sessionId)}/schedules/${encodeURIComponent(scheduleId)}`,
        { method: 'DELETE' },
      ).then((r) => readJson(r, 'deleteClaudeSchedule')),

    getResumeAfterLimit: (sessionId: string): Promise<ResumeAfterLimitResponse> =>
      authFetch(
        `${base}/api/sessions/${encodeURIComponent(sessionId)}/resume-after-limit`,
      ).then((r) => readJson<ResumeAfterLimitResponse>(r, 'getResumeAfterLimit')),

    scheduleResumeAfterLimit: (
      sessionId: string,
    ): Promise<ScheduleResumeAfterLimitResponse> =>
      authFetch(
        `${base}/api/sessions/${encodeURIComponent(sessionId)}/resume-after-limit`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
      ).then((r) => readJson<ScheduleResumeAfterLimitResponse>(r, 'scheduleResumeAfterLimit')),
  };
}
