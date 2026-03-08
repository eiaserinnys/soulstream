/**
 * PromptComposer - 세션 생성/재개용 중앙 프롬프트 입력
 *
 * 세션이 선택되지 않은 초기 상태에서 중앙에 표시됩니다.
 * 세션 생성 후 자동으로 해당 세션을 활성화하고 SSE 구독을 시작합니다.
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { useDashboardStore } from "../stores/dashboard-store";
import { getAuthHeaders, AuthTokenRequiredError } from "../lib/api-headers";
import { cn } from "../lib/cn";
import { Button } from "./ui/button";
import type { CreateSessionResponse } from "@shared/types";

/** Soul 서버의 MAX_PROMPT_LENGTH과 일치 (세션 생성 프롬프트의 최대 길이) */
const MAX_LENGTH = 100_000;

export function PromptComposer() {
  const resumeTargetKey = useDashboardStore((s) => s.resumeTargetKey);
  const cancelCompose = useDashboardStore((s) => s.cancelCompose);
  const completeCompose = useDashboardStore((s) => s.completeCompose);
  const sessionsLoading = useDashboardStore((s) => s.sessionsLoading);

  // 서버 초기 접속 중 여부 (session list SSE가 아직 연결되지 않은 상태)
  const serverConnecting = sessionsLoading;

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
      const headers = await getAuthHeaders();

      // Create & Resume 모두 POST /api/sessions 단일 엔드포인트 사용
      // Resume 시 agentSessionId를 전달하여 기존 세션 ID 재사용
      const response = await fetch("/api/sessions", {
        method: "POST",
        headers,
        body: JSON.stringify({
          prompt: trimmed,
          ...(resumeTargetKey ? { agentSessionId: resumeTargetKey } : {}),
        }),
      });

      if (!response.ok) {
        const body = await response
          .json()
          .catch(() => ({ error: { message: "Unknown error" } }));
        throw new Error(body.error?.message ?? `HTTP ${response.status}`);
      }

      const result: CreateSessionResponse = await response.json();

      // 세션 생성 성공 → 단일 atomic 호출로 낙관적 추가 + compose 종료 + 세션 활성화
      completeCompose(result.agentSessionId, trimmed);
    } catch (err) {
      if (err instanceof AuthTokenRequiredError) {
        setError("Authentication required. Please set your API token in Settings.");
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("Failed to start session");
      }
    } finally {
      setSending(false);
    }
  }, [text, sending, resumeTargetKey, completeCompose]);

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

  // 서버 미연결 시 (resume이 아닌 경우에만): 접속 대기 UI 표시
  if (!isResume && serverConnecting) {
    return (
      <div
        data-testid="prompt-composer"
        className="flex flex-col items-center justify-center h-full p-10 animate-[fadeIn_0.2s_ease-out]"
      >
        <div className="flex flex-col items-center gap-3">
          <span className="w-2 h-2 rounded-full bg-accent-amber animate-[pulse_2s_infinite]" />
          <div className="text-sm text-muted-foreground">
            Connecting to server...
          </div>
        </div>
      </div>
    );
  }

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
          className="w-full bg-input border border-input rounded-lg py-3.5 px-4 text-[15px] text-foreground font-sans resize-none outline-none min-h-20 max-h-[200px] leading-normal transition-colors duration-150 focus:border-accent-blue/40"
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
