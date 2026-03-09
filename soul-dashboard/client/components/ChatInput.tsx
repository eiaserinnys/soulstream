/**
 * ChatInput - 인터벤션 / 세션 계속 컴포넌트
 *
 * Running 세션: Intervention 모드로 실행 중인 Claude에 메시지 전송 (/intervene)
 * Completed/Error 세션: New Chat 모드로 대화 이어가기 (/resume → 새 세션 전환)
 */

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useDashboardStore } from "../stores/dashboard-store";
import { getAuthHeaders } from "../lib/api-headers";
import { cn } from "../lib/cn";
import { Button } from "./ui/button";

/** Soul 서버의 MAX_MESSAGE_LENGTH과 일치 (인터벤션 메시지의 최대 길이) */
const MAX_LENGTH = 50_000;

export function ChatInput() {
  const activeSessionKey = useDashboardStore((s) => s.activeSessionKey);
  const sessions = useDashboardStore((s) => s.sessions);

  // 활성 세션의 상태
  const sessionStatus = useMemo(() => {
    if (!activeSessionKey) return null;
    const session = sessions.find(
      (s) => s.agentSessionId === activeSessionKey,
    );
    return session?.status ?? null;
  }, [activeSessionKey, sessions]);

  const isRunning = sessionStatus === "running";
  const isCompleted = sessionStatus === "completed";
  const isError = sessionStatus === "error";
  const isFinished = isCompleted || isError;

  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // 세션 변경 시 상태 초기화 & in-flight 요청 취소
  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setText("");
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
      const headers = await getAuthHeaders();

      // running/completed 구분 없이 항상 /intervene로 전송
      // Soul 서버가 태스크 상태에 따라 intervention 또는 자동 resume 분기
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
    } catch (err) {
      // AbortError는 의도적 취소이므로 무시
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Failed to send");
    } finally {
      setSending(false);
    }
  }, [activeSessionKey, text, sending]);

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
  const placeholder = isFinished
    ? "Continue the conversation..."
    : "Send a message to Claude...";
  const buttonLabel = sending ? "..." : isFinished ? "Resume" : "Send";

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
              <span className="text-xs">{isFinished ? "\u{1F4AC}" : "\u270B"}</span>
              {isFinished ? "New Chat" : "Intervention"}
            </div>
            <div className="text-[10px] text-muted-foreground/60">
              Ctrl+Enter to send
            </div>
          </div>
          {/* Textarea */}
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={sending}
            rows={1}
            className={cn(
              "w-full bg-input border border-border rounded-md py-1.5 px-2.5",
              "text-[13px] text-foreground font-sans resize-none outline-none",
              "h-8 max-h-[120px] leading-[1.4] transition-colors duration-150",
              isFinished
                ? "focus:border-accent-blue/40"
                : "focus:border-accent-orange/40",
            )}
          />
        </div>
        {/* Right: button aligned to textarea bottom, matching textarea height (h-8 = 32px) */}
        <Button
          data-testid="send-button"
          onClick={sendMessage}
          disabled={isDisabled}
          size="sm"
          className={cn(
            "self-end h-8 sm:h-8",
            isFinished
              ? "border-accent-blue bg-accent-blue text-white hover:bg-accent-blue/90"
              : "border-accent-orange bg-accent-orange text-white hover:bg-accent-orange/90",
          )}
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
