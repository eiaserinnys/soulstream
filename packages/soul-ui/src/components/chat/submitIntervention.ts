/**
 * submitIntervention — 실행 중(running) 세션에 메시지를 주입한다.
 *
 * `POST /api/sessions/{sessionId}/intervene` 로 텍스트 + 첨부를 전송한다.
 * 세션 lifecycle은 sessions stream이 갱신하며 이 채팅 명령 경로는 건드리지 않는다.
 */

import { appendAttachmentPathNotes } from "../../lib/attachment-path-notes";
import { extractErrorMessage } from "./submitErrors";

export interface SubmitInterventionContext {
  /** 세션 식별자 (activeSessionKey). */
  sessionKey: string;
  /** 사용자가 입력한 메시지 (이미 trim 된 상태). */
  text: string;
  /** 서버에 업로드된 첨부 파일 경로. 없으면 생략한다. */
  attachmentPaths?: string[];
  /** fetch AbortController 의 signal. 이전 요청 취소 지원. */
  signal?: AbortSignal;
}

export interface SubmitInterventionResult {
  ok: true;
}

export async function submitIntervention(
  ctx: SubmitInterventionContext,
): Promise<SubmitInterventionResult> {
  const { sessionKey, text, attachmentPaths, signal } = ctx;
  const messageText = appendAttachmentPathNotes(text, attachmentPaths);

  // R-2 fix(2026-05-10): `credentials: "include"`를 명시한다. 동 리포의 다른
  // dashboard fetch(예: useMessageHistoryBuffer.ts:129,187)는 모두 명시하고 있으며,
  // cross-subdomain 배포 시 cookie(JWT) 미전송으로 caller_info 신원이 사라지는
  // G-1 회로(atom bfdf8f2f)를 §9 대칭성으로 닫는다.
  const response = await fetch(
    `/api/sessions/${encodeURIComponent(sessionKey)}/intervene`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        text: messageText,
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

  return { ok: true };
}
