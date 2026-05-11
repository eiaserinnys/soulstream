/**
 * submitLlmContinuation — 완료(completed) 또는 오류(error) 상태의 LLM 세션에
 * 이전 대화 히스토리를 누적해 새 LLM 요청을 전송한다.
 *
 * `POST /api/llm/completions` 는 server-side에서 새 세션을 생성하고 응답을 스트리밍한다.
 * 응답의 `session_id` 로 자동 전환해 사용자는 끊김 없이 대화를 이어갈 수 있다.
 *
 * buildLlmHistory 를 내부에서 사용해 트리를 history 포맷으로 변환하고,
 * 현재 입력(text)을 user 메시지로 덧붙여 전송한다.
 *
 * R-4 fix(2026-05-11, atom G-10): dashboard auth context user를 body.caller_info dict로
 * 박는다. build_browser_caller_info(soul_common.auth.caller_info)의 client-side 동등 조립
 * — falsy filter §9 대칭. caller 부재 시 caller_info 키 자체 부재 (graceful, 서버 측
 * LlmExecutor가 build_system_caller_info fallback으로 자연 흡수).
 */

import type { EventTreeNode } from "@shared/types";
import { buildLlmHistory } from "./buildLlmHistory";
import { extractErrorMessage } from "./submitErrors";

/** dashboard auth context user — submitLlmContinuation이 caller_info dict로 조립.
 *  AuthProvider의 AuthUser와 호환 (email/name/picture 3키). */
export interface SubmitLlmContinuationCaller {
  email: string;
  name: string;
  picture?: string;
}

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
  /** R-4 (atom G-10): dashboard auth context user. caller_info dict를 build_browser_caller_info
   *  §9 대칭으로 body에 박는다. undefined면 body.caller_info 키 부재 (서버 측 system fallback). */
  caller?: SubmitLlmContinuationCaller;
}

export interface SubmitLlmContinuationResult {
  ok: true;
  /** 서버가 생성한 새 세션 ID. 자동 활성 전환에 사용한다. */
  sessionId?: string;
}

/**
 * R-4 (atom G-10): caller 정보를 caller_info v1 dict로 조립. build_browser_caller_info의
 * client-side 동등 조립 — JWT 디코드 없이 already-decoded user를 직접 받음.
 * falsy filter — picture 빈 값/undefined는 avatar_url 키 제외 (graceful).
 */
function buildCallerInfoFromUser(
  caller: SubmitLlmContinuationCaller,
): Record<string, unknown> {
  const promoted: Record<string, unknown> = {
    source: "browser",
    display_name: caller.name,
    user_id: caller.email,
    email: caller.email,
    avatar_url: caller.picture,
  };
  // source는 항상 박음, 그 외는 truthy만 (build_browser_caller_info §9 대칭)
  const info: Record<string, unknown> = { source: promoted.source };
  for (const [k, v] of Object.entries(promoted)) {
    if (k !== "source" && v) {
      info[k] = v;
    }
  }
  return info;
}

export async function submitLlmContinuation(
  ctx: SubmitLlmContinuationContext,
): Promise<SubmitLlmContinuationResult> {
  const { tree, text, provider, model, clientId, signal, caller } = ctx;

  const history = buildLlmHistory(tree);
  const messages = [...history, { role: "user", content: text }];

  // R-4 (atom G-10): caller truthy → caller_info dict 첨부. falsy → 키 부재.
  const callerInfo = caller ? buildCallerInfoFromUser(caller) : undefined;

  const response = await fetch("/api/llm/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider,
      model,
      messages,
      client_id: clientId,
      ...(callerInfo ? { caller_info: callerInfo } : {}),
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
