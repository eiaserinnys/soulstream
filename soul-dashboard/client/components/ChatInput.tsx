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
  const setActiveSession = useDashboardStore((s) => s.setActiveSession);

  // 활성 세션의 상태
  const sessionStatus = useMemo(() => {
    if (!activeSessionKey) return null;
    const session = sessions.find(
      (s) => `${s.clientId}:${s.requestId}` === activeSessionKey,
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
  const [lastSent, setLastSent] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // 세션 변경 시 상태 초기화 & in-flight 요청 취소
  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setText("");
    setSending(false);
    setError(null);
    setLastSent(null);
  }, [activeSessionKey]);

  // textarea 높이 자동 조절
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
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
      let response: Response;

      if (isFinished) {
        // Completed/Error → resume API로 새 세션 생성
        response = await fetch(
          `/api/sessions/${encodeURIComponent(activeSessionKey)}/resume`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({ prompt: trimmed }),
            signal: controller.signal,
          },
        );
      } else {
        // Running → intervene API로 메시지 전송
        response = await fetch(
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
      }

      if (!response.ok) {
        const body = await response.json().catch(() => ({ error: { message: "Unknown error" } }));
        throw new Error(body.error?.message ?? `HTTP ${response.status}`);
      }

      if (isFinished) {
        // Resume 성공 → 새 세션으로 전환
        const result = await response.json();
        setActiveSession(result.sessionKey);
      } else {
        setLastSent(trimmed);
      }
      setText("");
    } catch (err) {
      // AbortError는 의도적 취소이므로 무시
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Failed to send");
    } finally {
      setSending(false);
    }
  }, [activeSessionKey, text, sending, isFinished, setActiveSession]);

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
      className="border-t border-border p-3 flex flex-col gap-2 shrink-0"
    >
      {/* Label */}
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground uppercase tracking-[0.05em] font-semibold">
        <span className="text-xs">{isFinished ? "\u{1F4AC}" : "\u270B"}</span>
        {isFinished ? "New Chat" : "Intervention"}
      </div>

      {/* Input area */}
      <div className="flex gap-2 items-end">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={sending}
          rows={1}
          className={cn(
            "flex-1 bg-input border border-border rounded-md py-2 px-2.5",
            "text-[13px] text-foreground font-sans resize-none outline-none",
            "min-h-9 max-h-[120px] leading-[1.4] transition-colors duration-150",
            isFinished
              ? "focus:border-accent-blue/40"
              : "focus:border-accent-orange/40",
          )}
        />
        <Button
          data-testid="send-button"
          onClick={sendMessage}
          disabled={isDisabled}
          size="sm"
          className={cn(
            "shrink-0",
            isFinished
              ? "border-accent-blue bg-accent-blue text-white hover:bg-accent-blue/90"
              : "border-accent-orange bg-accent-orange text-white hover:bg-accent-orange/90",
          )}
        >
          {buttonLabel}
        </Button>
      </div>

      {/* Hint */}
      <div className="text-[10px] text-muted-foreground/60">
        Ctrl+Enter to send
      </div>

      {/* Error */}
      {error && (
        <div className="text-[11px] text-accent-red py-1 px-2 rounded bg-accent-red/8">
          {error}
        </div>
      )}

      {/* Last sent confirmation */}
      {lastSent && !error && (
        <div className="text-[11px] text-success truncate">
          Sent: {lastSent.length > 60 ? lastSent.slice(0, 57) + "..." : lastSent}
        </div>
      )}
    </div>
  );
}
