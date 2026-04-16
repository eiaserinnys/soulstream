/**
 * submitLlmContinuation — 완료(completed) 또는 오류(error) 상태의 LLM 세션에
 * 이전 대화 히스토리를 누적해 새 LLM 요청을 전송한다.
 *
 * `POST /api/llm/completions` 는 server-side에서 새 세션을 생성하고 응답을 스트리밍한다.
 * 응답의 `session_id` 로 자동 전환해 사용자는 끊김 없이 대화를 이어갈 수 있다.
 *
 * buildLlmHistory 를 내부에서 사용해 트리를 history 포맷으로 변환하고,
 * 현재 입력(text)을 user 메시지로 덧붙여 전송한다.
 */

import type { EventTreeNode } from "@shared/types";
import { buildLlmHistory } from "./buildLlmHistory";
import { extractErrorMessage } from "./submitErrors";

export interface SubmitLlmContinuationContext {
  /** 현재 활성 세션의 트리 — 히스토리 추출 대상. */
  tree: EventTreeNode | null | undefined;
  /** 사용자가 입력한 메시지 (trim 된 상태). */
  text: string;
  /** 세션 메타데이터 — LLM 엔드포인트 호출에 필요. */
  provider?: string;
  model?: string;
  clientId?: string;
  /** fetch AbortController 의 signal. */
  signal?: AbortSignal;
}

export interface SubmitLlmContinuationResult {
  ok: true;
  /** 서버가 생성한 새 세션 ID. 자동 활성 전환에 사용한다. */
  sessionId?: string;
}

export async function submitLlmContinuation(
  ctx: SubmitLlmContinuationContext,
): Promise<SubmitLlmContinuationResult> {
  const { tree, text, provider, model, clientId, signal } = ctx;

  const history = buildLlmHistory(tree);
  const messages = [...history, { role: "user", content: text }];

  const response = await fetch("/api/llm/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider,
      model,
      messages,
      client_id: clientId,
    }),
    signal,
  });

  if (!response.ok) {
    const body = await response
      .json()
      .catch(() => ({ detail: "Unknown error" }));
    throw new Error(extractErrorMessage(body, response.status));
  }

  const result = await response.json();
  return {
    ok: true,
    sessionId: typeof result?.session_id === "string" ? result.session_id : undefined,
  };
}
