import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../../api/client';
import { ApiHttpError } from '../../api/clientCore';
import type { Session } from '../../api/types';
import { appendAttachmentPathNotes } from '../../utils/attachmentPathNotes';
import {
  useChatStore,
  createOptimisticUserEvent,
  pickOptimisticVariant,
  type PendingOptimisticAttachment,
  type PendingOptimisticEvent,
} from '../../store/chatStore';
// ChatAttachment 타입은 import하지 않는다. 전송 경로와 복원을 위한 path/name만 구조적으로
// 받아 첨부 도메인의 lifecycle은 알지 않는다.

export interface UseChatSendFlowDeps {
  /** API 클라이언트. null이면 재시도 가능한 준비 중 오류를 노출한다. */
  api: ApiClient | null;
  /** 현재 세션 ID. undefined면 세션 식별 오류를 노출한다. */
  sessionId: string | undefined;
  /** 현재 세션 객체. status에 따라 optimistic variant 결정 (서버 분기 거울, chatStore.pickOptimisticVariant 참조). */
  session: Session | undefined;
  /** 전송·복원에 필요한 첨부 path와 선택 이름. 첨부 lifecycle에는 의존하지 않는다. */
  attachments: ReadonlyArray<{ path: string; name?: string }>;
  /** 실제 전송을 시작한 직후 첨부 목록을 비운다. */
  clearAttachments: () => void;
  /**
   * 송신 시점에 list viewport를 visual bottom으로 정렬한다.
   * 호출자(ChatBody)가 flatListRef를 캡슐화하여 RAF로 호출하는 콜백을 주입한다.
   *
   * 정본 분리 (design-principles §3):
   * - (1) loadHistoryPage if(!before) — 첫 페이지 진입 시 1회 (resume UX)
   * - (2) MVCP autoscrollToTopThreshold:10 — 라이브 데이터 매 건 (offset 임계 안일 때)
   * - (3) 본 콜백 — 사용자 송신 시 1회 (baseline 정렬 → (2)가 반드시 잡도록 보장)
   * 세 정본은 서로 다른 이벤트의 정본이며, 본 콜백이 (2)의 race 영역을 닫는다.
   *
   * MVCP autoscrollToTopThreshold:10은 contentOffset이 임계 안일 때만 자동 추적하므로,
   * 키보드/KAV transform/attachmentRow measurement race 영역에서는 침묵한다.
   * 사용자 액션 시점에 명시 정렬하여 그 race 영역을 닫는다 — 회귀의 구조적 차단.
   */
  scrollToBottom: () => void;
  /** offline current-open session의 입력 race를 UI 아래 경계에서도 차단한다. */
  disabled?: boolean;
  /** UI 사용 로그용 최소 송신 사실. 원문·첨부 경로는 전달하지 않는다. */
  onUsageEvent?: (event: ChatSendUsageEvent) => void;
  onSendConfirmed?: (originalText: string) => void;
}

export type ChatSendUsageEvent =
  | { kind: 'submit'; draftLength: number; flowId?: string | null }
  | {
    kind: 'result';
    status: 'ok' | 'error' | 'aborted';
    durationMs: number;
    flowId?: string | null;
    errorCode?: string;
    sessionEventId?: string | number;
  };

export interface UseChatSendFlowResult {
  sending: boolean;
  hasPendingOptimistic: boolean;
  sendError: string | null;
  retryPendingOptimistic: (eventId: string) => Promise<void>;
  restorePendingOptimistic: (
    eventId: string,
    currentText: string,
  ) => { inputText: string; attachments: PendingOptimisticAttachment[] } | undefined;
  /**
   * 사용자가 입력한 텍스트를 송신한다.
   *
   * @param text 호출자(ChatBody)가 input state를 그대로 전달. trim 결과 빈 문자열이면 silent no-op.
   * @param onCleared 실제 송신을 시작하며 입력창을 비울 때 호출.
   * @param flowId 입력창 비우기 전 현재 compose flow ID.
   */
  handleSend: (text: string, onCleared: () => void, flowId?: string | null) => Promise<void>;
}

export const CHAT_SEND_ERROR_MESSAGES = {
  apiUnavailable:
    '서버 설정을 준비하고 있습니다. 잠시 후 다시 시도해 주세요.',
  sessionUnavailable:
    '현재 세션을 확인할 수 없어 메시지를 보낼 수 없습니다.',
  disabled:
    '노드 연결을 기다리는 동안 메시지와 첨부를 보낼 수 없습니다.',
} as const;

/**
 * 채팅 송신 흐름의 비-React 부분을 캡슐화한 훅.
 *
 * § 추출 근거:
 * - design-principles §10(인터페이스가 테스트 표면) — ChatBody 풀 mount 비용 회피
 * - module-size-limit (ChatBody.tsx 497줄 → 본 추출로 안전 마진 확보)
 * - 사용자 송신 시점의 정본 snap을 외부 주입 가능한 형태로 표면화하여 회귀 방지 테스트 가능
 *
 * § 회귀 차단 invariant:
 * 사용자가 메시지를 송신하는 모든 경로(빈 입력 제외)에서 scrollToBottom이 정확히 1회 호출되어야 한다.
 * api.intervene 실패 분기에서도 호출됨 — 송신 직후 placeholder가 시각적으로 보였으므로 정렬은 의미 있다.
 */
export function useChatSendFlow(
  deps: UseChatSendFlowDeps,
): UseChatSendFlowResult {
  const {
    api,
    sessionId,
    session,
    attachments,
    clearAttachments,
    scrollToBottom,
    disabled = false,
    onUsageEvent,
    onSendConfirmed,
  } = deps;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const [sendError, setSendError] = useState<string | null>(null);
  const pendingOptimistic = useChatStore((state) =>
    sessionId ? state.pendingOptimisticBySession[sessionId] : undefined,
  );
  const sending = pendingOptimistic?.pendingStatus === 'sending';
  const hasPendingOptimistic = pendingOptimistic?.pendingStatus !== undefined;

  // 세션 전환 시 직전 세션의 sendError가 화면에 남지 않도록 명시 리셋.
  // (기존 ChatBody mount effect의 setSendError(null) 동작을 보존 — sendError 정본을 본 훅으로
  // 옮기면서 세션 전환 동기화 책임도 함께 이동.)
  useEffect(() => {
    setSendError(null);
  }, [sessionId]);

  async function handleSend(
    text: string,
    onCleared: () => void,
    usageFlowId?: string | null,
  ): Promise<void> {
    const msg = text.trim();
    if (!msg) return;
    if (!api) {
      setSendError(CHAT_SEND_ERROR_MESSAGES.apiUnavailable);
      return;
    }
    if (!sessionId) {
      setSendError(CHAT_SEND_ERROR_MESSAGES.sessionUnavailable);
      return;
    }
    if (useChatStore.getState().pendingOptimisticBySession[sessionId]?.pendingStatus) {
      return;
    }
    if (disabledRef.current) {
      setSendError(CHAT_SEND_ERROR_MESSAGES.disabled);
      return;
    }
    setSendError(null);
    // optimistic insert: 사용자가 보낸 메시지를 즉시 채팅 뷰에 표시. events 배열이 아닌
    // 별도 슬롯(pendingOptimisticBySession)에 보관하여 RN ScrollView Caveat 1 (reordering jank)
    // 회피. 서버 user_message/intervention_sent SSE가 도착하면 mergeEvents가 텍스트 일치로
    // 슬롯을 비운다 (시나리오 A, type-agnostic). 전송 실패는 같은 칸의 상태만 바꾼다.
    //
    // variant 결정: 서버 task_manager.add_intervention의 분기를 거울처럼 따른다.
    // - RUNNING 세션: intervention_queue 경로 → 서버가 'intervention_sent'(주황) emit
    // - 그 외(완료/오류/idle 등): create_task 경로 → 서버가 'user_message'(파랑) emit
    // 색을 정합시켜 옵티미스틱 → 진짜 이벤트 전환 시 색 깜빡임을 제거한다.
    // race(클릭 직후 status 전환)는 chatStore의 type-agnostic dedup이 받친다.
    const attachmentItems = attachments.map(({ path, name }) => ({ path, name }));
    const paths = attachmentItems.map((attachment) => attachment.path);
    const messageText = appendAttachmentPathNotes(
      msg,
      paths.length > 0 ? paths : undefined
    );
    const variant = pickOptimisticVariant(session?.status);
    const optimistic: PendingOptimisticEvent = {
      ...createOptimisticUserEvent(messageText, variant),
      pendingStatus: 'sending',
      originalText: text,
      attachmentItems,
      usageFlowId,
    };
    useChatStore.getState().setPendingOptimistic(sessionId, optimistic, true);
    // 사용자 액션 시점의 정본 snap 트리거 — typing indicator(=session.status='running'이
    // 켜질 때 reversedItems[0]로 들어가는 항목)가 InputBar에 가려지는 회귀를 구조적으로 차단.
    // (자세한 의미는 deps.scrollToBottom 주석 참조)
    scrollToBottom();
    reportUsage(onUsageEvent, {
      kind: 'submit',
      draftLength: text.length,
      ...(usageFlowId === undefined ? {} : { flowId: usageFlowId }),
    });
    onCleared();
    clearAttachments();
    await sendPendingOptimistic(optimistic);
  }

  async function retryPendingOptimistic(eventId: string): Promise<void> {
    if (!api || !sessionId) return;
    const pending = useChatStore.getState().pendingOptimisticBySession[sessionId];
    if (!pending || pending.id !== eventId || pending.pendingStatus !== 'failed') {
      return;
    }
    useChatStore.getState().updatePendingOptimisticStatus(sessionId, eventId, 'sending');
    const text = pending.originalText ?? String(pending.data.text ?? '');
    reportUsage(onUsageEvent, {
      kind: 'submit',
      draftLength: text.length,
      ...(pending.usageFlowId === undefined ? {} : { flowId: pending.usageFlowId }),
    });
    await sendPendingOptimistic(pending);
  }

  function restorePendingOptimistic(
    eventId: string,
    currentText: string,
  ): { inputText: string; attachments: PendingOptimisticAttachment[] } | undefined {
    if (!sessionId) return undefined;
    const pending = useChatStore.getState().pendingOptimisticBySession[sessionId];
    if (!pending || pending.id !== eventId || pending.pendingStatus !== 'failed') {
      return undefined;
    }
    useChatStore.getState().clearPendingOptimistic(sessionId, eventId);
    const originalText = pending.originalText ?? '';
    return {
      inputText: currentText.length > 0 && currentText !== originalText
        ? `${originalText}\n\n${currentText}`
        : originalText,
      attachments: pending.attachmentItems ?? [],
    };
  }

  async function sendPendingOptimistic(pending: PendingOptimisticEvent): Promise<void> {
    if (!api || !sessionId) return;
    const sentAt = Date.now();
    const messageText = String(pending.data.text ?? '');
    const paths = pending.attachmentItems?.map((attachment) => attachment.path) ?? [];
    try {
      const verdict = await api.intervene(
        sessionId,
        messageText,
        paths.length > 0 ? paths : undefined,
      );
      if (verdict.delivered === null || verdict.outcome === 'unknown') {
        useChatStore.getState().updatePendingOptimisticStatus(
          sessionId,
          pending.id,
          'failed',
          '전달을 확인하지 못했습니다',
        );
        reportUsage(onUsageEvent, {
          kind: 'result',
          status: 'aborted',
          durationMs: Date.now() - sentAt,
          ...(pending.usageFlowId === undefined ? {} : { flowId: pending.usageFlowId }),
        });
        return;
      }
      if (pending.originalText !== undefined) onSendConfirmed?.(pending.originalText);
      reportUsage(onUsageEvent, {
        kind: 'result',
        status: 'ok',
        durationMs: Date.now() - sentAt,
        ...(pending.usageFlowId === undefined ? {} : { flowId: pending.usageFlowId }),
        ...(verdict.sessionEventId === undefined
          ? {}
          : { sessionEventId: verdict.sessionEventId }),
      });
    } catch (e: any) {
      useChatStore.getState().updatePendingOptimisticStatus(
        sessionId,
        pending.id,
        'failed',
        getSendFailureReason(e),
      );
      reportUsage(onUsageEvent, {
        kind: 'result',
        status: 'error',
        durationMs: Date.now() - sentAt,
        ...(pending.usageFlowId === undefined ? {} : { flowId: pending.usageFlowId }),
        errorCode: usageErrorCode(e),
      });
    }
  }

  return {
    sending,
    hasPendingOptimistic,
    sendError,
    handleSend,
    retryPendingOptimistic,
    restorePendingOptimistic,
  };
}

function getSendFailureReason(error: unknown): string {
  if (error instanceof ApiHttpError) {
    let message = `HTTP ${error.status}`;
    try {
      const body = JSON.parse(error.body) as { detail?: unknown };
      if (typeof body.detail === 'string') message = body.detail;
    } catch {
      // Non-JSON bodies use the stable HTTP status fallback.
    }
    return `전송하지 못했습니다: ${message}`;
  }
  return '전달을 확인하지 못했습니다';
}

function reportUsage(
  callback: UseChatSendFlowDeps['onUsageEvent'],
  event: ChatSendUsageEvent,
): void {
  try {
    callback?.(event);
  } catch (error) {
    // 수집은 부가 기능이다. 송신 결과를 뒤집거나 사용자에게 오류를 보이지 않는다.
    console.warn('[chat] usage event skipped:', error);
  }
}

function usageErrorCode(error: unknown): string {
  if (error instanceof Error && error.name && error.name !== 'Error') {
    return error.name.slice(0, 80);
  }
  return 'request_failed';
}
