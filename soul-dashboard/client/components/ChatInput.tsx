/**
 * ChatInput - 인터벤션 / 세션 계속 / LLM 컨텍스트 전송 컴포넌트
 *
 * Running 세션: Intervention 모드로 실행 중인 Claude에 메시지 전송 (/intervene)
 * Completed/Error 세션: New Chat 모드로 대화 이어가기 (/resume → 새 세션 전환)
 * LLM 완료 세션: 이전 대화 컨텍스트를 누적하여 새 LLM 요청 전송 (/api/llm/completions)
 */

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import type { SessionSummary } from "@shared/types";
import { useDashboardStore } from "../stores/dashboard-store";
import { flattenTree } from "../lib/flatten-tree";
import { cn } from "../lib/cn";
import { Button } from "./ui/button";

/** Soul 서버의 MAX_MESSAGE_LENGTH과 일치 (인터벤션 메시지의 최대 길이) */
const MAX_LENGTH = 50_000;

interface ActiveSessionInfo {
  status: string | null;
  isLlm: boolean;
  llmProvider?: string;
  llmModel?: string;
  clientId?: string;
}

export function ChatInput() {
  const activeSessionKey = useDashboardStore((s) => s.activeSessionKey);
  const sessions = useDashboardStore((s) => s.sessions);
  const tree = useDashboardStore((s) => s.tree);
  const treeVersion = useDashboardStore((s) => s.treeVersion);
  const setActiveSession = useDashboardStore((s) => s.setActiveSession);
  const setDraft = useDashboardStore((s) => s.setDraft);
  const clearDraft = useDashboardStore((s) => s.clearDraft);

  // 활성 세션의 상태 + LLM 메타데이터
  const sessionInfo = useMemo((): ActiveSessionInfo => {
    if (!activeSessionKey) return { status: null, isLlm: false };
    const session = sessions.find(
      (s: SessionSummary) => s.agentSessionId === activeSessionKey,
    );
    if (!session) return { status: null, isLlm: false };
    return {
      status: session.status,
      isLlm: session.sessionType === "llm",
      llmProvider: session.llmProvider,
      llmModel: session.llmModel,
      clientId: session.clientId,
    };
  }, [activeSessionKey, sessions]);

  const isLlm = sessionInfo.isLlm;
  const isRunning = sessionInfo.status === "running";
  const isCompleted = sessionInfo.status === "completed";
  const isError = sessionInfo.status === "error";
  const isFinished = isCompleted || isError;
  const isLlmFinished = isLlm && isFinished;

  // LLM 대화 컨텍스트: 트리에서 user/assistant 메시지를 추출
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const llmMessages = useMemo(() => {
    if (!isLlm || !tree) return [];
    const flat = flattenTree(tree);
    const msgs: Array<{ role: string; content: string }> = [];
    for (const m of flat) {
      if (m.role === "user") msgs.push({ role: "user", content: m.content });
      else if (m.role === "assistant" && m.treeNodeType === "assistant_message")
        msgs.push({ role: "assistant", content: m.content });
    }
    return msgs;
  }, [isLlm, tree, treeVersion]);

  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // 세션 변경 시 상태 초기화 & in-flight 요청 취소
  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    // 세션 전환 시 저장된 draft 복원 (getState()로 직접 읽어 의존성에 drafts 불필요)
    const saved = activeSessionKey
      ? (useDashboardStore.getState().drafts[activeSessionKey] ?? "")
      : "";
    setText(saved);
    setSending(false);
    setError(null);
  }, [activeSessionKey]);

  // textarea 높이 자동 조절 (기본 32px, 최대 120px)
  // Button size="sm"과 맞추기 위해 32px(h-8) 사용
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${Math.max(32, Math.min(el.scrollHeight, 120))}px`;
    }
  }, [text]);

  const sendMessage = useCallback(async () => {
    if (!activeSessionKey || !text.trim() || sending) return;

    const trimmed = text.trim();
    if (trimmed.length > MAX_LENGTH) {
      setError(`Message too long (${trimmed.length}/${MAX_LENGTH})`);
      return;
    }

    // 이전 요청 취소
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setSending(true);
    setError(null);

    try {
      const headers = { "Content-Type": "application/json" };

      if (isLlmFinished) {
        // LLM 완료 세션: 이전 컨텍스트 + 새 메시지를 /api/llm/completions로 전송
        const response = await fetch("/api/llm/completions", {
          method: "POST",
          headers,
          body: JSON.stringify({
            provider: sessionInfo.llmProvider,
            model: sessionInfo.llmModel,
            messages: [...llmMessages, { role: "user", content: trimmed }],
            client_id: sessionInfo.clientId,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const body = await response.json().catch(() => ({ error: { message: "Unknown error" } }));
          throw new Error(body.error?.message ?? `HTTP ${response.status}`);
        }

        const result = await response.json();
        setText("");
        if (activeSessionKey) clearDraft(activeSessionKey); // 이전 세션 draft 삭제 (setActiveSession 전에 처리)

        // 새 세션으로 자동 전환
        if (result.session_id) {
          setActiveSession(result.session_id);
        }
      } else {
        // Claude 세션 또는 running LLM: 기존 /intervene 경로
        const response = await fetch(
          `/api/sessions/${encodeURIComponent(activeSessionKey)}/intervene`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              text: trimmed,
              user: "dashboard",
            }),
            signal: controller.signal,
          },
        );

        if (!response.ok) {
          const body = await response.json().catch(() => ({ error: { message: "Unknown error" } }));
          throw new Error(body.error?.message ?? `HTTP ${response.status}`);
        }

        await response.json();
        setText("");
        if (activeSessionKey) clearDraft(activeSessionKey);
      }
    } catch (err) {
      // AbortError는 의도적 취소이므로 무시
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Failed to send");
    } finally {
      setSending(false);
    }
  }, [activeSessionKey, text, sending, isLlmFinished, sessionInfo, llmMessages, setActiveSession, clearDraft]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Ctrl+Enter / Cmd+Enter로 전송
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        sendMessage();
      }
    },
    [sendMessage],
  );

  if (!activeSessionKey) return null;

  const isDisabled = sending || !text.trim();

  // LLM 완료 세션: 컨텍스트 누적 모드
  const ctxCount = llmMessages.length;
  const placeholder = isLlmFinished
    ? `Send with ${ctxCount} messages context...`
    : isFinished
      ? "Continue the conversation..."
      : "Send a message to Claude...";
  const buttonLabel = sending ? "..." : isLlmFinished ? "Send" : isFinished ? "Resume" : "Send";
  const modeIcon = isLlmFinished ? "\u{1F916}" : isFinished ? "\u{1F4AC}" : "\u270B";
  const modeLabel = isLlmFinished
    ? `LLM (${ctxCount} ctx)`
    : isFinished ? "New Chat" : "Intervention";

  // 색상: LLM 완료 → success(초록), resume → accent-blue, intervention → accent-orange
  const borderColor = isLlmFinished
    ? "focus:border-success/40"
    : isFinished
      ? "focus:border-accent-blue/40"
      : "focus:border-accent-orange/40";
  const buttonColor = isLlmFinished
    ? "border-success bg-success text-white hover:bg-success/90"
    : isFinished
      ? "border-accent-blue bg-accent-blue text-white hover:bg-accent-blue/90"
      : "border-accent-orange bg-accent-orange text-white hover:bg-accent-orange/90";

  return (
    <div
      data-testid="chat-input"
      className="border-t border-border p-[var(--panel-inset)] shrink-0"
    >
      <div className="flex gap-2">
        {/* Left column: labels + textarea */}
        <div className="flex-1 flex flex-col gap-1">
          {/* Labels row */}
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground uppercase tracking-[0.05em] font-semibold">
              <span className="text-xs">{modeIcon}</span>
              {modeLabel}
            </div>
            <div className="text-[10px] text-muted-foreground/60">
              Ctrl+Enter to send
            </div>
          </div>
          {/* Textarea */}
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (activeSessionKey) setDraft(activeSessionKey, e.target.value);
            }}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={sending}
            rows={1}
            className={cn(
              "w-full bg-input border border-border rounded-md py-1.5 px-2.5",
              "text-[16px] text-foreground font-sans resize-none outline-none",
              "h-8 max-h-[120px] leading-[1.4] transition-colors duration-150",
              borderColor,
            )}
          />
        </div>
        {/* Right: button aligned to textarea bottom, matching textarea height (h-8 = 32px) */}
        <Button
          data-testid="send-button"
          onClick={sendMessage}
          disabled={isDisabled}
          size="sm"
          className={cn("self-end h-8 sm:h-8", buttonColor)}
        >
          {buttonLabel}
        </Button>
      </div>

      {/* Error */}
      {error && (
        <div className="text-[11px] text-accent-red py-1 px-2 rounded bg-accent-red/8">
          {error}
        </div>
      )}

    </div>
  );
}
