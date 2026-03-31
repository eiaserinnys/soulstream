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
import { FileAttachmentPreview } from "./FileAttachmentPreview";
import { useFileUpload } from "../hooks/useFileUpload";

/** Soul 서버의 MAX_MESSAGE_LENGTH과 일치 (인터벤션 메시지의 최대 길이) */
const MAX_LENGTH = 50_000;

interface ActiveSessionInfo {
  status: string | null;
  isLlm: boolean;
  llmProvider?: string;
  llmModel?: string;
  clientId?: string;
}

interface ChatInputProps {
  /** 외부에서 주입하는 추가 비활성화 조건 (예: 오케스트레이터에서 노드 dead 상태) */
  additionalDisabled?: boolean;
  /**
   * 파일 업로드 URL.
   * 있으면 파일 첨부 버튼이 활성화된다.
   * 없으면 파일 첨부 UI 숨김 (기존 동작 유지).
   * soul-dashboard: "/attachments/sessions"
   * orchestrator-dashboard: "/api/attachments/sessions?nodeId={id}"
   */
  fileUploadUrl?: string;
}

export function ChatInput({ additionalDisabled = false, fileUploadUrl }: ChatInputProps = {}) {
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
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 파일 업로드 훅 — activeSessionKey를 sessionId로 사용
  // fileUploadUrl이 없으면 noop (빈 URL)
  const {
    files,
    isUploading,
    addFiles,
    removeFile,
    resetLocal,
    uploadedPaths,
  } = useFileUpload({
    uploadUrl: fileUploadUrl ?? "",
    sessionId: activeSessionKey ?? "",
  });

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
    // 세션 전환 시 첨부 파일 로컬 상태 초기화
    resetLocal();
  }, [activeSessionKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // textarea 높이 자동 조절
  // 모바일(< 640px): h-9(36px), 데스크탑: h-8(32px)에 맞춤
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      const minH = window.innerWidth < 640 ? 36 : 32;
      el.style.height = "auto";
      el.style.height = `${Math.max(minH, Math.min(el.scrollHeight, 120))}px`;
    }
  }, [text]);

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        addFiles(e.target.files);
        e.target.value = "";
      }
    },
    [addFiles],
  );

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
          const body = await response.json().catch(() => ({ detail: "Unknown error" }));
          throw new Error(body.detail ?? body.error?.message ?? `HTTP ${response.status}`);
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
        const attachmentPaths = fileUploadUrl && uploadedPaths.length > 0
          ? uploadedPaths
          : undefined;

        const response = await fetch(
          `/api/sessions/${encodeURIComponent(activeSessionKey)}/intervene`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              text: trimmed,
              user: "dashboard",
              ...(attachmentPaths ? { attachmentPaths } : {}),
            }),
            signal: controller.signal,
          },
        );

        if (!response.ok) {
          const body = await response.json().catch(() => ({ detail: "Unknown error" }));
          throw new Error(body.detail ?? body.error?.message ?? `HTTP ${response.status}`);
        }

        await response.json();
        setText("");
        if (activeSessionKey) clearDraft(activeSessionKey);
        // 파일 첨부가 있었으면 로컬 상태 초기화 (서버 파일은 유지 — Claude가 읽어야 함)
        if (fileUploadUrl && files.length > 0) {
          resetLocal();
        }
        // intervene 성공 즉시 세션 상태를 running으로 업데이트하여
        // subscriptionEpoch를 즉시 증가시킨다 (5초 폴링 대기 없이 SSE 재구독).
        if (activeSessionKey) {
          useDashboardStore.getState().updateSession(activeSessionKey, { status: "running" });
        }
      }
    } catch (err) {
      // AbortError는 의도적 취소이므로 무시
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Failed to send");
    } finally {
      setSending(false);
    }
  }, [activeSessionKey, text, sending, isLlmFinished, sessionInfo, llmMessages, setActiveSession, clearDraft, fileUploadUrl, uploadedPaths, files, resetLocal]);

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

  const fileUploadDisabled = fileUploadUrl ? isUploading : false;
  const isDisabled = sending || !text.trim() || additionalDisabled || fileUploadDisabled;

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
      {/* 첨부 파일 목록 (fileUploadUrl이 있고 파일이 있을 때만) */}
      {fileUploadUrl && files.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-2">
          {files.map((f) => (
            <FileAttachmentPreview
              key={f.id}
              file={f.file}
              status={f.status}
              onRemove={() => removeFile(f.id)}
            />
          ))}
        </div>
      )}

      <div className="flex gap-2">
        {/* Paperclip button (fileUploadUrl이 있을 때만) */}
        {fileUploadUrl && (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="self-end h-9 sm:h-8 px-2 flex items-center justify-center rounded border border-border text-muted-foreground hover:text-foreground hover:border-border/80 transition-colors"
            title="Attach files"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
        )}

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
              "text-[16px] sm:text-[15px] text-foreground font-sans resize-none outline-none",
              "h-9 sm:h-8 max-h-[120px] leading-[1.4] transition-colors duration-150",
              borderColor,
            )}
          />
        </div>
        {/* Right: button aligned to textarea bottom, matching textarea height (h-9 = 36px) */}
        <Button
          data-testid="send-button"
          onClick={sendMessage}
          disabled={isDisabled}
          size="sm"
          className={cn("self-end h-9 sm:h-8 text-[16px] sm:text-[14px]", buttonColor)}
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

      {/* Hidden file input */}
      {fileUploadUrl && (
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileInputChange}
        />
      )}
    </div>
  );
}
