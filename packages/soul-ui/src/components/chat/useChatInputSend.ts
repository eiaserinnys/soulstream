/**
 * useChatInputSend — ChatInput 의 submit 디스패처 훅.
 *
 * 일반 세션 메시지는 dashboard store의 세션별 pending 칸으로 상태를 관리한다.
 * LLM continuation은 기존 전송·취소 동작을 유지한다.
 */

import { useCallback, useRef, useState } from "react";
import type { EventTreeNode } from "@shared/types";
import type { PendingChatSend, PendingChatSendAttachment } from "../../stores/dashboard-store-types";
import { useAuth } from "../../providers/AuthProvider";
import { appendAttachmentPathNotes } from "../../lib/attachment-path-notes";
import { submitIntervention, SubmitInterventionHttpError } from "./submitIntervention";
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
  uploadedAttachments: PendingChatSendAttachment[];
  getPendingChatSend: (sessionId: string) => PendingChatSend | undefined;
  setPendingChatSend: (sessionId: string, pending: PendingChatSend | null) => void;
  clearDraft: (key: string) => void;
  setActiveSession: (key: string) => void;
  /** 전송 검증 통과 직후 호출: 입력창·첨부를 네트워크 응답 전에 비운다. */
  onBeforeSend?: (text: string) => void;
  /** 서버 요청이 성공적으로 응답했을 때 사용 로그를 정리한다. */
  onAfterSend: () => void;
  /** 실패 응답의 사용 로그를 유지한다. 입력창 복원에는 사용하지 않는다. */
  onSendFailure?: () => void;
  /** LLM continuation 실패는 기존 입력창 복원 동작을 유지한다. */
  onSendError?: (text: string) => void;
  onRetry?: (sessionId: string, pending: PendingChatSend) => void;
}

export interface UseChatInputSendResult {
  sending: boolean;
  error: string | null;
  /** 세션 전환 시 LLM continuation만 취소한다. 메시지 요청은 세션별 칸에 남긴다. */
  reset: () => void;
  send: (rawText: string) => Promise<void>;
  retry: (sessionId: string, pending: PendingChatSend) => Promise<void>;
}

const UNKNOWN_DELIVERY_REASON = "전달을 확인하지 못했습니다";

function getFailureReason(error: unknown): string {
  if (error instanceof SubmitInterventionHttpError) {
    return `전송하지 못했습니다: ${error.message}`;
  }
  return UNKNOWN_DELIVERY_REASON;
}

export function useChatInputSend(args: UseChatInputSendArgs): UseChatInputSendResult {
  const { isAuthenticated, user } = useAuth();
  const [llmSendingSessionKey, setLlmSendingSessionKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const llmSendingSessionRef = useRef<string | null>(null);

  const activePending = args.activeSessionKey
    ? args.getPendingChatSend(args.activeSessionKey)
    : undefined;
  const sending = activePending?.status === "sending" ||
    (args.activeSessionKey !== null && llmSendingSessionKey === args.activeSessionKey);

  const submitPending = useCallback(async (sessionId: string, pending: PendingChatSend) => {
    try {
      const context = {
        sessionKey: sessionId,
        text: pending.messageText,
        attachmentPaths: pending.attachmentPaths.length > 0
          ? pending.attachmentPaths
          : undefined,
      };
      const result = await (
        pending.mode === "resume" ? submitResume(context) : submitIntervention(context)
      );
      if (result.delivered === null) {
        const current = args.getPendingChatSend(sessionId);
        if (current?.id === pending.id) {
          args.setPendingChatSend(sessionId, {
            ...current,
            status: "failed",
            reason: UNKNOWN_DELIVERY_REASON,
          });
        }
        args.onSendFailure?.();
        return;
      }
      args.onAfterSend();
    } catch (requestError) {
      const current = args.getPendingChatSend(sessionId);
      if (current?.id === pending.id) {
        args.setPendingChatSend(sessionId, {
          ...current,
          status: "failed",
          reason: getFailureReason(requestError),
        });
      }
      args.onSendFailure?.();
    }
  }, [args]);

  const send = useCallback(
    async (rawText: string) => {
      const sessionId = args.activeSessionKey;
      if (!sessionId || !rawText.trim()) return;

      const trimmed = rawText.trim();
      if (trimmed.length > MAX_MESSAGE_LENGTH) {
        setError(`Message too long (${trimmed.length}/${MAX_MESSAGE_LENGTH})`);
        return;
      }

      if (args.isLlmFinished) {
        if (llmSendingSessionRef.current !== null) return;
        const controller = new AbortController();
        abortRef.current = controller;
        llmSendingSessionRef.current = sessionId;
        setLlmSendingSessionKey(sessionId);
        setError(null);
        args.clearDraft(sessionId);
        args.onBeforeSend?.(trimmed);
        try {
          const caller = isAuthenticated && user
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
          args.onAfterSend();
          if (result.sessionId) args.setActiveSession(result.sessionId);
        } catch (requestError) {
          if (requestError instanceof DOMException && requestError.name === "AbortError") return;
          args.onSendFailure?.();
          args.onSendError?.(trimmed);
          setError(requestError instanceof Error ? requestError.message : "Failed to send");
        } finally {
          if (llmSendingSessionRef.current === sessionId) {
            llmSendingSessionRef.current = null;
            abortRef.current = null;
            setLlmSendingSessionKey(null);
          }
        }
        return;
      }

      if (args.getPendingChatSend(sessionId)) return;
      const attachmentPaths = args.fileUploadUrl && args.uploadedPaths.length > 0
        ? [...args.uploadedPaths]
        : [];
      const messageText = appendAttachmentPathNotes(trimmed, attachmentPaths);
      const pending: PendingChatSend = {
        id: globalThis.crypto.randomUUID(),
        status: "sending",
        text: trimmed,
        messageText,
        attachmentPaths,
        attachments: [...args.uploadedAttachments],
        mode: args.isFinished ? "resume" : "intervention",
      };

      setError(null);
      args.setPendingChatSend(sessionId, pending);
      args.clearDraft(sessionId);
      args.onBeforeSend?.(messageText);
      await submitPending(sessionId, pending);
    },
    [args, isAuthenticated, user, submitPending],
  );

  const retry = useCallback(async (sessionId: string, pending: PendingChatSend) => {
    const current = args.getPendingChatSend(sessionId);
    if (!current || current.id !== pending.id || current.status !== "failed") return;
    const retrying: PendingChatSend = {
      ...current,
      status: "sending",
      reason: undefined,
    };
    args.setPendingChatSend(sessionId, retrying);
    args.onRetry?.(sessionId, retrying);
    await submitPending(sessionId, retrying);
  }, [args, submitPending]);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    llmSendingSessionRef.current = null;
    setLlmSendingSessionKey(null);
    setError(null);
  }, []);

  return { sending, error, reset, send, retry };
}
