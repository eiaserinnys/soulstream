/**
 * PromptComposer - 세션 생성/재개용 중앙 프롬프트 입력
 *
 * 세션이 선택되지 않은 초기 상태에서 중앙에 표시됩니다.
 * 세션 생성 후 자동으로 해당 세션을 활성화하고 SSE 구독을 시작합니다.
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { useDashboardStore } from "../stores/dashboard-store";
import { getAuthHeaders } from "../lib/api-headers";

const ACCENT = "#3b82f6";
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

  return (
    <div
      data-testid="prompt-composer"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        padding: "40px",
        animation: "fadeIn 0.2s ease-out",
      }}
    >
      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      <div
        style={{
          width: "100%",
          maxWidth: "600px",
          display: "flex",
          flexDirection: "column",
          gap: "16px",
        }}
      >
        {/* Title */}
        <div
          style={{
            fontSize: "16px",
            fontWeight: 600,
            color: "#e5e7eb",
            textAlign: "center",
          }}
        >
          {isResume ? "Continue Conversation" : "New Conversation"}
        </div>

        {/* Resume context */}
        {isResume && (
          <div
            style={{
              fontSize: "12px",
              color: "#9ca3af",
              textAlign: "center",
              padding: "8px 12px",
              backgroundColor: "rgba(59, 130, 246, 0.08)",
              borderRadius: "6px",
              border: "1px solid rgba(59, 130, 246, 0.15)",
            }}
          >
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
          style={{
            width: "100%",
            backgroundColor: "rgba(0,0,0,0.3)",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: "8px",
            padding: "14px 16px",
            fontSize: "14px",
            color: "#d1d5db",
            fontFamily:
              "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
            resize: "none",
            outline: "none",
            minHeight: "80px",
            maxHeight: "200px",
            lineHeight: "1.5",
            transition: "border-color 0.15s",
          }}
          onFocus={(e) => {
            e.currentTarget.style.borderColor = "rgba(59, 130, 246, 0.4)";
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = "rgba(255,255,255,0.12)";
          }}
        />

        {/* Actions */}
        <div
          style={{
            display: "flex",
            gap: "8px",
            justifyContent: "flex-end",
            alignItems: "center",
          }}
        >
          <span style={{ fontSize: "11px", color: "#4b5563", flex: 1 }}>
            Ctrl+Enter to submit, Esc to cancel
          </span>

          <button
            onClick={cancelCompose}
            disabled={sending}
            style={{
              padding: "8px 16px",
              borderRadius: "6px",
              border: "1px solid rgba(255,255,255,0.1)",
              backgroundColor: "transparent",
              color: "#9ca3af",
              fontSize: "13px",
              cursor: "pointer",
              transition: "all 0.15s",
            }}
          >
            Cancel
          </button>

          <button
            data-testid="compose-submit"
            onClick={submit}
            disabled={sending || !text.trim()}
            style={{
              padding: "8px 20px",
              borderRadius: "6px",
              border: "none",
              backgroundColor:
                sending || !text.trim()
                  ? "rgba(255,255,255,0.05)"
                  : ACCENT,
              color: sending || !text.trim() ? "#6b7280" : "#fff",
              fontSize: "13px",
              fontWeight: 600,
              cursor: sending || !text.trim() ? "default" : "pointer",
              transition: "all 0.15s",
            }}
          >
            {sending ? "Starting..." : isResume ? "Resume" : "Start"}
          </button>
        </div>

        {/* Error */}
        {error && (
          <div
            style={{
              fontSize: "12px",
              color: "#ef4444",
              padding: "8px 12px",
              borderRadius: "6px",
              backgroundColor: "rgba(239, 68, 68, 0.08)",
            }}
          >
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
