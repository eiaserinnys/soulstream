/**
 * PromptComposer - 세션 생성/재개용 중앙 프롬프트 입력
 *
 * 세션이 선택되지 않은 초기 상태에서 중앙에 표시됩니다.
 * 세션 생성 후 자동으로 해당 세션을 활성화하고 SSE 구독을 시작합니다.
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { useDashboardStore } from "../stores/dashboard-store";
import { getAuthHeaders } from "../lib/api-headers";
import { cn } from "../lib/cn";
import { Button } from "./ui/button";

/** Soul 서버의 MAX_PROMPT_LENGTH과 일치 (세션 생성 프롬프트의 최대 길이) */
const MAX_LENGTH = 100_000;

export function PromptComposer() {
  const resumeTargetKey = useDashboardStore((s) => s.resumeTargetKey);
  const cancelCompose = useDashboardStore((s) => s.cancelCompose);
  const setActiveSession = useDashboardStore((s) => s.setActiveSession);

  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 마운트 시 자동 포커스
  useEffect(() => {
    const timer = setTimeout(() => textareaRef.current?.focus(), 100);
    return () => clearTimeout(timer);
  }, []);

  // textarea 높이 자동 조절
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    }
  }, [text]);

  const submit = useCallback(async () => {
    if (!text.trim() || sending) return;

    const trimmed = text.trim();
    if (trimmed.length > MAX_LENGTH) {
      setError(`Prompt too long (${trimmed.length}/${MAX_LENGTH})`);
      return;
    }

    setSending(true);
    setError(null);

    try {
      let response: Response;

      const headers = await getAuthHeaders();

      if (resumeTargetKey) {
        // Resume: POST /api/sessions/:id/resume
        response = await fetch(
          `/api/sessions/${encodeURIComponent(resumeTargetKey)}/resume`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({ prompt: trimmed }),
          },
        );
      } else {
        // Create: POST /api/sessions
        response = await fetch("/api/sessions", {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: trimmed }),
        });
      }

      if (!response.ok) {
        const body = await response
          .json()
          .catch(() => ({ error: { message: "Unknown error" } }));
        throw new Error(body.error?.message ?? `HTTP ${response.status}`);
      }

      const result = await response.json();

      // 세션 생성 성공 → composing 종료, 활성 세션 전환
      cancelCompose();
      setActiveSession(result.sessionKey);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start session");
    } finally {
      setSending(false);
    }
  }, [text, sending, resumeTargetKey, cancelCompose, setActiveSession]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        submit();
      }
      if (e.key === "Escape") {
        cancelCompose();
      }
    },
    [submit, cancelCompose],
  );

  const isResume = !!resumeTargetKey;
  const isDisabled = sending || !text.trim();

  return (
    <div
      data-testid="prompt-composer"
      className="flex flex-col items-center justify-center h-full p-10 animate-[fadeIn_0.2s_ease-out]"
    >
      <div className="w-full max-w-[600px] flex flex-col gap-4">
        {/* Title */}
        <div className="text-base font-semibold text-foreground text-center">
          {isResume ? "Continue Conversation" : "New Conversation"}
        </div>

        {/* Resume context */}
        {isResume && (
          <div className="text-xs text-muted-foreground text-center py-2 px-3 bg-accent-blue/8 rounded-md border border-accent-blue/15">
            Resuming from: {resumeTargetKey}
          </div>
        )}

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            isResume
              ? "What would you like to continue with?"
              : "What would you like to work on?"
          }
          disabled={sending}
          rows={3}
          className="w-full bg-input border border-input rounded-lg py-3.5 px-4 text-sm text-foreground font-sans resize-none outline-none min-h-20 max-h-[200px] leading-normal transition-colors duration-150 focus:border-accent-blue/40"
        />

        {/* Actions */}
        <div className="flex gap-2 justify-end items-center">
          <span className="text-[11px] text-muted-foreground/60 flex-1">
            Ctrl+Enter to submit, Esc to cancel
          </span>

          <Button
            variant="outline"
            onClick={cancelCompose}
            disabled={sending}
          >
            Cancel
          </Button>

          <Button
            data-testid="compose-submit"
            onClick={submit}
            disabled={isDisabled}
            className="bg-accent-blue border-accent-blue text-white hover:bg-accent-blue/90"
          >
            {sending ? "Starting..." : isResume ? "Resume" : "Start"}
          </Button>
        </div>

        {/* Error */}
        {error && (
          <div className="text-xs text-accent-red py-2 px-3 rounded-md bg-accent-red/8">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
