/**
 * useChatInputSend — ChatInput 의 submit 디스패처 훅.
 *
 * 세션 상태(running/completed/error, Claude/LLM)에 따라 submit 전략을 호출하고
 * 공통 제어(abort, sending, error)를 관리한다. UI 상태(text/height/focus)는 호출자 소유.
 *
 * R-4 fix(2026-05-11, atom G-10): useAuth() hook으로 dashboard auth context user를 추출하여
 * submitLlmContinuation에 caller로 forward. LLM continuation 시 wire/DB에 dashboard 사용자
 * 본인 정체성이 박혀 D1/D5에 시스템(Soulstream) 대신 본인 표시된다.
 */

import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { EventTreeNode } from "@shared/types";
import { useAuth } from "../../providers/AuthProvider";
import { submitIntervention } from "./submitIntervention";
import { submitResume } from "./submitResume";
import { submitLlmContinuation } from "./submitLlmContinuation";

/** Soul 서버의 MAX_MESSAGE_LENGTH과 일치 (인터벤션 메시지의 최대 길이) */
export const MAX_MESSAGE_LENGTH = 50_000;

export interface UseChatInputSendArgs {
  activeSessionKey: string | null;
  tree: EventTreeNode | null | undefined;
  isFinished: boolean;
  isLlmFinished: boolean;
  llmProvider?: string;
  llmModel?: string;
  clientId?: string;
  fileUploadUrl?: string;
  uploadedPaths: string[];
  hasFiles: boolean;
  resetLocal: () => void;
  clearDraft: (key: string) => void;
  setActiveSession: (key: string) => void;
  /** 전송 검증 통과 직후 호출: 네트워크 응답 전 입력창을 낙관적으로 비운다. */
  onBeforeSend?: (text: string) => void;
  /** 전송 성공 시 호출: 입력 텍스트를 초기화할 수 있게 한다. */
  onAfterSend: () => void;
  /** 전송 실패 시 호출: 낙관적으로 비운 입력값을 복원할 수 있게 한다. */
  onSendError?: (text: string) => void;
}

export interface UseChatInputSendResult {
  sending: boolean;
  error: string | null;
  /** 세션 전환 / 언마운트 시 호출. in-flight 요청 abort + 상태 리셋. */
  reset: () => void;
  /** 입력 텍스트(trim 전)를 받아 적절한 전략을 디스패치한다. 제한 초과 시 에러만 설정. */
  send: (rawText: string) => Promise<void>;
}

export function useChatInputSend(args: UseChatInputSendArgs): UseChatInputSendResult {
  const queryClient = useQueryClient();
  const { isAuthenticated, user } = useAuth();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback(
    async (rawText: string) => {
      const { activeSessionKey } = args;
      if (!activeSessionKey || !rawText.trim() || sending) return;

      const trimmed = rawText.trim();
      if (trimmed.length > MAX_MESSAGE_LENGTH) {
        setError(`Message too long (${trimmed.length}/${MAX_MESSAGE_LENGTH})`);
        return;
      }

      // 이전 요청 취소
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setSending(true);
      setError(null);
      args.onBeforeSend?.(trimmed);

      try {
        let nextSessionId: string | undefined;
        if (args.isLlmFinished) {
          // R-4 (atom G-10): dashboard auth context user → submitLlmContinuation caller로 forward.
          // 인증 비활성/미로그인이면 caller undefined (서버 측 LlmExecutor system fallback 자연 흡수).
          const caller =
            isAuthenticated && user
              ? { email: user.email, name: user.name, picture: user.picture }
              : undefined;
          const result = await submitLlmContinuation({
            tree: args.tree,
            text: trimmed,
            provider: args.llmProvider,
            model: args.llmModel,
            clientId: args.clientId,
            caller,
            signal: controller.signal,
          });
          nextSessionId = result.sessionId;
        } else {
          const attachmentPaths =
            args.fileUploadUrl && args.uploadedPaths.length > 0 ? args.uploadedPaths : undefined;
          const ctx = {
            sessionKey: activeSessionKey,
            text: trimmed,
            attachmentPaths,
            queryClient,
            signal: controller.signal,
          };
          await (args.isFinished ? submitResume(ctx) : submitIntervention(ctx));
          // 파일 첨부가 있었으면 로컬 상태 초기화 (서버 파일은 유지 — Claude가 읽어야 함)
          if (args.fileUploadUrl && args.hasFiles) args.resetLocal();
        }
        args.onAfterSend();
        args.clearDraft(activeSessionKey);
        if (nextSessionId) args.setActiveSession(nextSessionId);
      } catch (err) {
        // AbortError는 의도적 취소이므로 무시
        if (err instanceof DOMException && err.name === "AbortError") return;
        args.onSendError?.(trimmed);
        setError(err instanceof Error ? err.message : "Failed to send");
      } finally {
        setSending(false);
      }
    },
    [sending, args, queryClient, isAuthenticated, user],
  );

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setSending(false);
    setError(null);
  }, []);

  return { sending, error, reset, send };
}
