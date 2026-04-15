/**
 * ChatView 전용 hooks
 *
 * useLlmContext: LLM 세션 여부와 모델/프로바이더 정보를 반환.
 * useLazyLoadContent: truncate된 콘텐츠의 전체 로드 상태 관리.
 */

import { useMemo, useState, useRef, useCallback } from "react";
import { useDashboardStore } from "../../stores/dashboard-store";
import type { ChatMessage } from "../../lib/flatten-tree";

// === LLM Context ===

export interface LlmContext {
  isLlm: boolean;
  llmModel?: string;
  llmProvider?: string;
}

export function useLlmContext(): LlmContext {
  const activeSessionSummary = useDashboardStore((s) => s.activeSessionSummary);
  return useMemo(() => {
    if (!activeSessionSummary || activeSessionSummary.sessionType !== "llm") return { isLlm: false };
    return {
      isLlm: true,
      llmModel: activeSessionSummary.llmModel,
      llmProvider: activeSessionSummary.llmProvider,
    };
  }, [activeSessionSummary]);
}

// === Truncation Lazy Load ===

export function useLazyLoadContent(
  msg: ChatMessage,
): {
  displayContent: string | undefined;
  isTruncated: boolean;
  loading: boolean;
  error: string | null;
  loadFullContent: () => void;
} {
  const activeSessionKey = useDashboardStore((s) => s.activeSessionKey);
  const [fullContent, setFullContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadingRef = useRef(false);

  const isTruncated = !!msg.isTruncated && fullContent === null;

  const loadFullContent = useCallback(async () => {
    if (!activeSessionKey || !msg.fullContentEventId || loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(activeSessionKey)}/events/${msg.fullContentEventId}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const record = await res.json();
      const event = record.event;
      // tool_result 이벤트: result 필드, thinking 이벤트: thinking 필드
      const content = event.result ?? event.thinking ?? event.text ?? "";
      setFullContent(content);
    } catch {
      setError("로드 실패. 다시 시도해주세요.");
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [activeSessionKey, msg.fullContentEventId]);

  // tool 메시지의 경우 toolResult, thinking의 경우 content
  const baseContent =
    msg.treeNodeType === "thinking"
      ? msg.thinkingContent ?? msg.content
      : msg.toolResult;

  return {
    displayContent: fullContent ?? baseContent,
    isTruncated,
    loading,
    error,
    loadFullContent,
  };
}
