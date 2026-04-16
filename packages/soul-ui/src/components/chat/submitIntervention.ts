/**
 * submitIntervention — 실행 중(running) 세션에 메시지를 주입한다.
 *
 * `POST /api/sessions/{sessionId}/intervene` 로 텍스트 + 첨부를 전송하고,
 * 성공 시 React Query 캐시에서 해당 세션 상태를 즉시 'running'으로 갱신해
 * SSE 재구독 에포크를 앞당긴다 (5초 폴링 대기 제거).
 *
 * 순수에 가까운 함수 — 외부 상태는 파라미터로 주입된 콜백으로만 갱신한다.
 */

import type { QueryClient, InfiniteData } from "@tanstack/react-query";
import {
  applySessionUpdated,
  type SessionPage,
} from "../../hooks/session-stream-helpers";
import { extractErrorMessage } from "./submitErrors";

export interface SubmitInterventionContext {
  /** 세션 식별자 (activeSessionKey). */
  sessionKey: string;
  /** 사용자가 입력한 메시지 (이미 trim 된 상태). */
  text: string;
  /** 서버에 업로드된 첨부 파일 경로. 없으면 생략한다. */
  attachmentPaths?: string[];
  /** React Query 클라이언트. 세션 상태 즉시 갱신에 사용. */
  queryClient: QueryClient;
  /** fetch AbortController 의 signal. 이전 요청 취소 지원. */
  signal?: AbortSignal;
}

export interface SubmitInterventionResult {
  ok: true;
}

export async function submitIntervention(
  ctx: SubmitInterventionContext,
): Promise<SubmitInterventionResult> {
  const { sessionKey, text, attachmentPaths, queryClient, signal } = ctx;

  const response = await fetch(
    `/api/sessions/${encodeURIComponent(sessionKey)}/intervene`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        user: "dashboard",
        ...(attachmentPaths && attachmentPaths.length > 0
          ? { attachmentPaths }
          : {}),
      }),
      signal,
    },
  );

  if (!response.ok) {
    const body = await response
      .json()
      .catch(() => ({ detail: "Unknown error" }));
    throw new Error(extractErrorMessage(body, response.status));
  }

  await response.json();

  // intervene 성공 즉시 세션 상태를 running으로 업데이트하여
  // subscriptionEpoch를 즉시 증가시킨다 (5초 폴링 대기 없이 SSE 재구독).
  queryClient.setQueriesData<InfiniteData<SessionPage>>(
    { queryKey: ["sessions"], exact: false },
    (old) => {
      if (!old) return old;
      return applySessionUpdated(old, sessionKey, { status: "running" });
    },
  );

  return { ok: true };
}
