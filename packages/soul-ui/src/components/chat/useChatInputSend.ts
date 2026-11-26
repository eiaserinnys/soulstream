/**
 * useChatInputSend — ChatInput 의 submit 디스패처 훅.
 *
 * 일반 세션 메시지는 dashboard store의 세션별 pending 칸으로 상태를 관리한다.
 */

import { useCallback, useState } from "react";
import type { PendingChatSend, PendingChatSendAttachment } from "../../stores/dashboard-store-types";
import { appendAttachmentPathNotes } from "@soulstream/wire-schema/attachment-path-notes";
import { submitIntervention, SubmitInterventionHttpError } from "./submitIntervention";
import { submitResume } from "./submitResume";
import type { ReportSendContext } from '../../shared/persistent-report';

/** Soul 서버의 MAX_MESSAGE_LENGTH과 일치 (인터벤션 메시지의 최대 길이) */
export const MAX_MESSAGE_LENGTH = 50_000;

export interface UseChatInputSendArgs {
  activeSessionKey: string | null;
  isFinished: boolean;
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
  onRetry?: (sessionId: string, pending: PendingChatSend) => void;
  getMessageContext?: (text: string) => ReportSendContext;
}

export interface UseChatInputSendResult {
  sending: boolean;
  error: string | null;
  /** 세션 전환 시 입력 오류를 지운다. 메시지 요청은 세션별 칸에 남긴다. */
  reset: () => void;
  send: (rawText: string) => Promise<void>;
  retry: (sessionId: string, pending: PendingChatSend) => Promise<void>;
  retryDelivery: (
    sessionId: string,
    message: { text: string; attachmentPaths: readonly string[] },
  ) => Promise<void>;
}

const UNKNOWN_DELIVERY_REASON = "전달을 확인하지 못했습니다";

function getFailureReason(error: unknown): string {
  if (error instanceof SubmitInterventionHttpError) {
    return `전송하지 못했습니다: ${error.message}`;
  }
  return UNKNOWN_DELIVERY_REASON;
}

export function useChatInputSend(args: UseChatInputSendArgs): UseChatInputSendResult {
  const [error, setError] = useState<string | null>(null);

  const activePending = args.activeSessionKey
    ? args.getPendingChatSend(args.activeSessionKey)
    : undefined;
  const sending = activePending?.status === "sending";

  const submitPending = useCallback(async (sessionId: string, pending: PendingChatSend) => {
    try {
      const context = {
        sessionKey: sessionId,
        text: pending.messageText,
        contextItems: pending.contextItems,
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
      const current = args.getPendingChatSend(sessionId);
      if (result.reason === "card_question_answered") {
        if (current?.id === pending.id) args.setPendingChatSend(sessionId, null);
      } else if (current?.id === pending.id && current.persistentReportOperation) {
        args.setPendingChatSend(sessionId, { ...current, persistentReportOperation: { ...current.persistentReportOperation, acknowledged: true } });
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
      const attachmentPaths = args.fileUploadUrl ? [...args.uploadedPaths] : [];
      if (!sessionId || (!rawText.trim() && attachmentPaths.length === 0)) return;

      const trimmed = rawText.trim();
      if (trimmed.length > MAX_MESSAGE_LENGTH) {
        setError(`메시지가 너무 깁니다 (${trimmed.length}/${MAX_MESSAGE_LENGTH})`);
        return;
      }

      if (args.getPendingChatSend(sessionId)) return;
      const messageText = appendAttachmentPathNotes(trimmed, attachmentPaths);
      const pending: PendingChatSend = {
        id: globalThis.crypto.randomUUID(),
        status: "sending",
        text: trimmed,
        messageText,
        attachmentPaths,
        attachments: [...args.uploadedAttachments],
        mode: args.isFinished ? "resume" : "intervention",
        ...args.getMessageContext?.(trimmed),
      };

      setError(null);
      args.setPendingChatSend(sessionId, pending);
      args.clearDraft(sessionId);
      args.onBeforeSend?.(messageText);
      await submitPending(sessionId, pending);
    },
    [args, submitPending],
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

  /**
   * 전달 장부에서 실패로 닫힌 말풍선의 다시 보내기 (카드 #1524).
   *
   * 입력창의 초안·첨부는 건드리지 않는다. 보내는 중 표시는 기존 전송과 같은
   * pending 칸이 만들고, 이미 전송 중인 칸이 있으면 기존 규칙대로 막는다.
   */
  const retryDelivery = useCallback(async (
    sessionId: string,
    message: { text: string; attachmentPaths: readonly string[] },
  ) => {
    if (sessionId !== args.activeSessionKey) return;
    if (args.getPendingChatSend(sessionId)) return;
    const text = message.text.trim();
    const attachmentPaths = [...message.attachmentPaths];
    if (!text && attachmentPaths.length === 0) return;
    if (text.length > MAX_MESSAGE_LENGTH) {
      setError(`메시지가 너무 깁니다 (${text.length}/${MAX_MESSAGE_LENGTH})`);
      return;
    }
    const pending: PendingChatSend = {
      id: globalThis.crypto.randomUUID(),
      status: "sending",
      text,
      messageText: appendAttachmentPathNotes(text, attachmentPaths),
      attachmentPaths,
      attachments: [],
      mode: args.isFinished ? "resume" : "intervention",
      ...args.getMessageContext?.(text),
    };
    setError(null);
    args.setPendingChatSend(sessionId, pending);
    await submitPending(sessionId, pending);
  }, [args, submitPending]);

  const reset = useCallback(() => {
    setError(null);
  }, []);

  return { sending, error, reset, send, retry, retryDelivery };
}
