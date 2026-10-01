import type { ApiRequestContext } from './clientCore';

export function createRealtimeEndpoints({ base, authFetch, readJson }: ApiRequestContext) {
  return {
    createRealtimeCall: (
      sessionId: string,
      body: {
        offerSdp: string;
        model?: string;
        voice?: string;
        instructions?: string;
      },
    ): Promise<{ status: string; callId: string; answerSdp: string; [k: string]: unknown }> =>
      authFetch(
        `${base}/api/sessions/${encodeURIComponent(sessionId)}/realtime/call`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      ).then((r) => readJson(r, 'createRealtimeCall')),

    sendRealtimeEvent: (
      sessionId: string,
      event: Record<string, unknown>,
      callId?: string,
    ): Promise<{ status: string; normalizedType?: string; eventId?: number }> =>
      authFetch(
        `${base}/api/sessions/${encodeURIComponent(sessionId)}/realtime/events`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event, ...(callId ? { callId } : {}) }),
        },
      ).then((r) => readJson(r, 'sendRealtimeEvent')),

    resolveRealtimeToolApproval: (
      sessionId: string,
      approvalId: string,
      body: {
        decision: 'approved' | 'rejected';
        message?: string;
        source?: 'tap' | 'voice';
        callId?: string;
      },
    ): Promise<{
      status: string;
      approvalId: string;
      decision: 'approved' | 'rejected';
      dataChannelEvent?: Record<string, unknown>;
      [k: string]: unknown;
    }> =>
      authFetch(
        `${base}/api/sessions/${encodeURIComponent(sessionId)}/realtime/tool-approvals/${encodeURIComponent(approvalId)}/resolve`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      ).then((r) => readJson(r, 'resolveRealtimeToolApproval')),
  };
}
