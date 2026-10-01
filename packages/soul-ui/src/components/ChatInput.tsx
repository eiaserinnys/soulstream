/**
 * ChatInput - 인터벤션 / 세션 계속 / LLM 컨텍스트 전송 컴포넌트
 *
 * Running 세션: Intervention 모드로 실행 중인 Claude에 메시지 전송 (/intervene)
 * Completed/Error 세션: New Chat 모드로 대화 이어가기 (/resume → 새 세션 전환)
 * LLM 완료 세션: 이전 대화 컨텍스트를 누적하여 새 LLM 요청 전송 (/api/llm/completions)
 *
 * 세션 상태별 네트워크 로직은 ./chat/submit*.ts 전략 함수로 분리되고,
 * 본 컴포넌트는 레이아웃, draft/포커스, 세션 전환 사이드 이펙트에 집중한다.
 */

import { useCallback, useRef, useEffect, useMemo, useState } from "react";
import { Loader2, Square } from "lucide-react";
import { useDashboardStore } from "../stores/dashboard-store";
import { FileAttachmentPreview } from "./FileAttachmentPreview";
import { useFileUpload } from "../hooks/useFileUpload";
import { buildLlmHistory } from "./chat/buildLlmHistory";
import { resolveChatInputMode } from "./chat/chatInputMode";
import { PaperclipButton } from "./chat/PaperclipButton";
import { ChatInputEditor } from "./chat/ChatInputEditor";
import { useChatInputSend } from "./chat/useChatInputSend";
import { createComposeFlowRecorder } from "./chat/composeFlowRecorder";
import { useUiEventTracker } from "../lib/ui-events";
import { useTextareaAutoHeight } from "./chat/useTextareaAutoHeight";
import { SuggestionChip } from "./SuggestionChip";
import { Button } from "./ui/button";
import { ChatInputComposer } from "./chat/ChatInputComposer";
import { mergePendingTextIntoComposer, type PendingChatSendActions } from "./chat/pending-chat-send";
import type { PendingChatSend } from "../stores/dashboard-store-types";

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
  registerPendingSendActions?: (actions: PendingChatSendActions | null) => void;
}

export function ChatInput({
  additionalDisabled = false,
  fileUploadUrl,
  registerPendingSendActions,
}: ChatInputProps = {}) {
  const activeSessionKey = useDashboardStore((s) => s.activeSessionKey);
  const activeSessionSummary = useDashboardStore((s) => s.activeSessionSummary);
  const tree = useDashboardStore((s) => s.tree);
  const treeVersion = useDashboardStore((s) => s.treeVersion);
  const setActiveSession = useDashboardStore((s) => s.setActiveSession);
  const setDraft = useDashboardStore((s) => s.setDraft);
  const clearDraft = useDashboardStore((s) => s.clearDraft);
  const setPendingChatSend = useDashboardStore((s) => s.setPendingChatSend);
  const pendingChatSend = useDashboardStore((s) => (
    activeSessionKey ? s.pendingChatSends[activeSessionKey] : undefined
  ));
  // store-only selector — closure 외부 의존 0 (정본 하나).
  // primitive 반환이라 reference equality 안전.
  const lastSuggestion = useDashboardStore((s) =>
    s.activeSessionKey ? (s.lastPromptSuggestions[s.activeSessionKey] ?? null) : null,
  );

  // 세션 상태 파생값
  const status = activeSessionSummary?.status ?? null;
  const isLlm = activeSessionSummary?.sessionType === "llm";
  const isFinished = status === "completed" || status === "error";
  const isLlmFinished = isLlm && isFinished;
  const effectiveFileUploadUrl = isLlmFinished ? undefined : fileUploadUrl;

  // LLM 대화 컨텍스트: 트리에서 user/assistant 메시지를 추출
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const llmMessages = useMemo(
    () => (isLlm ? buildLlmHistory(tree) : []),
    [isLlm, tree, treeVersion],
  );

  const [text, setText] = useState("");
  // 사용 로그: 입력 구간 기록기. 초안 원문은 절대 싣지 않고 길이만 남긴다.
  const trackUiEvent = useUiEventTracker();
  const composeEvents = useMemo(
    () => createComposeFlowRecorder({
      track: trackUiEvent,
      newId: () => globalThis.crypto.randomUUID(),
      now: () => Date.now(),
    }),
    [trackUiEvent],
  );
  const textRef = useRef(text);
  textRef.current = text;
  const previousSessionKeyRef = useRef<string | null>(null);
  const composeMode = isLlmFinished ? "llm" : isFinished ? "resume" : "intervention";
  const [interrupting, setInterrupting] = useState(false);
  const [interruptError, setInterruptError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 파일 업로드 훅 — activeSessionKey를 sessionId로 사용 (fileUploadUrl 없으면 noop)
  const {
    files,
    isUploading,
    addFiles,
    removeFile,
    resetLocal,
    restoreUploadedFiles,
    uploadedPaths,
  } = useFileUpload({
    uploadUrl: effectiveFileUploadUrl ?? "",
    sessionId: activeSessionKey ?? "",
  });

  // submit 디스패처 훅 — sending / error / abort 관리 + 전략 호출
  const { sending, error, reset, send, retry } = useChatInputSend({
    activeSessionKey,
    tree,
    isFinished,
    isLlmFinished,
    llmProvider: activeSessionSummary?.llmProvider,
    llmModel: activeSessionSummary?.llmModel,
    clientId: activeSessionSummary?.clientId,
    fileUploadUrl: effectiveFileUploadUrl,
    uploadedPaths,
    uploadedAttachments: files.flatMap((file) => (
      file.status === "done" && file.path !== null
        ? [{ id: file.id, file: file.file, path: file.path }]
        : []
    )),
    getPendingChatSend: (sessionId) => useDashboardStore.getState().pendingChatSends[sessionId],
    setPendingChatSend,
    clearDraft,
    setActiveSession,
    onBeforeSend: () => {
      composeEvents.submitted(activeSessionKey, textRef.current.length, composeMode);
      setText("");
      if (!isLlmFinished) resetLocal();
    },
    onAfterSend: () => {
      composeEvents.settled("ok");
    },
    onSendFailure: () => composeEvents.settled("error"),
    onSendError: (failedText) => {
      setText(failedText);
      if (activeSessionKey) setDraft(activeSessionKey, failedText);
    },
    onRetry: (sessionId, pending) => {
      composeEvents.submitted(sessionId, pending.text.length, pending.mode);
    },
  });

  const restorePendingSend = useCallback((sessionId: string, pending: PendingChatSend) => {
    const current = useDashboardStore.getState().pendingChatSends[sessionId];
    if (
      sessionId !== activeSessionKey ||
      !current ||
      current.id !== pending.id ||
      current.status !== "failed"
    ) return;

    setPendingChatSend(sessionId, null);
    const restoredText = mergePendingTextIntoComposer(pending.text, textRef.current);
    setText(restoredText);
    setDraft(sessionId, restoredText);
    restoreUploadedFiles(pending.attachments.map(({ id, file, path }) => ({
      id,
      file,
      path,
      status: "done" as const,
    })));
  }, [activeSessionKey, restoreUploadedFiles, setDraft, setPendingChatSend]);

  useEffect(() => {
    registerPendingSendActions?.({
      retry: (sessionId, pending) => {
        void retry(sessionId, pending);
      },
      restore: restorePendingSend,
    });
    return () => registerPendingSendActions?.(null);
  }, [registerPendingSendActions, restorePendingSend, retry]);

  // 세션 변경 시 상태 초기화 & in-flight 요청 취소
  useEffect(() => {
    reset();
    setInterruptError(null);
    setInterrupting(false);
    // 세션 전환 시 저장된 draft 복원 (getState()로 직접 읽어 의존성에 drafts 불필요)
    const saved = activeSessionKey
      ? (useDashboardStore.getState().drafts[activeSessionKey] ?? "")
      : "";
    // 사용 로그: 초안을 둔 채 떠났는지 / 초안이 있는 곳으로 돌아왔는지.
    // 첫 마운트(previous === null)는 이탈이 아니므로 아무것도 남기지 않는다.
    const previousKey = previousSessionKeyRef.current;
    if (previousKey !== activeSessionKey) {
      composeEvents.sessionChanged(
        previousKey === null ? null : { key: previousKey, text: textRef.current },
        activeSessionKey === null ? null : { key: activeSessionKey, draft: saved },
      );
      previousSessionKeyRef.current = activeSessionKey;
    }
    setText(saved);
    resetLocal();
  }, [activeSessionKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // textarea 높이 자동 조절
  useTextareaAutoHeight(textareaRef, text);

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        addFiles(e.target.files);
        e.target.value = "";
      }
    },
    [addFiles],
  );

  const sendMessage = useCallback(() => {
    void send(text);
  }, [send, text]);

  const interruptSession = useCallback(async () => {
    if (!activeSessionKey || interrupting) return;
    setInterruptError(null);
    setInterrupting(true);
    // 사용 로그: 사용자가 눌러서 시작된 비동기 조작이고, 결과가 올 때까지 기다린다.
    // start/end 의 간격이 곧 그 기다림이다. end 가 없으면 종결을 못 본 것일 뿐이다.
    const actionFlowId = globalThis.crypto.randomUUID();
    const startedAt = Date.now();
    const target = { kind: "session", id: activeSessionKey } as const;
    trackUiEvent("action_start", {
      flowId: actionFlowId,
      target,
      attrs: { action: "session_interrupt" },
    });
    try {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(activeSessionKey)}/interrupt`,
        { method: "POST", credentials: "include" },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          body ? `HTTP ${res.status}: ${body.slice(0, 200)}` : `HTTP ${res.status}`,
        );
      }
      trackUiEvent("action_end", {
        flowId: actionFlowId,
        target,
        attrs: {
          action: "session_interrupt",
          status: "ok",
          durationMs: Date.now() - startedAt,
        },
      });
    } catch (err) {
      trackUiEvent("action_end", {
        flowId: actionFlowId,
        target,
        attrs: {
          action: "session_interrupt",
          status: "error",
          durationMs: Date.now() - startedAt,
        },
      });
      setInterruptError(err instanceof Error ? err.message : String(err));
    } finally {
      setInterrupting(false);
    }
  }, [activeSessionKey, interrupting, trackUiEvent]);

  const handleChangeText = useCallback(
    (value: string) => {
      // 빈 초안에 첫 글자가 들어온 순간만 입력 시작으로 본다. 타건 자체는 남기지 않는다.
      composeEvents.textChanged(activeSessionKey, textRef.current, value);
      setText(value);
      if (activeSessionKey) setDraft(activeSessionKey, value);
    },
    [activeSessionKey, setDraft, composeEvents],
  );

  if (!activeSessionKey) return null;

  const fileUploadDisabled = effectiveFileUploadUrl ? isUploading : false;
  const isDisabled = sending || pendingChatSend !== undefined || !text.trim() || additionalDisabled || fileUploadDisabled;
  const textareaDisabled = additionalDisabled;
  const showInterrupt = status === "running";
  const interruptDisabled = interrupting || additionalDisabled || !activeSessionKey;

  const mode = resolveChatInputMode({
    isFinished,
    isLlmFinished,
    sending,
    ctxCount: llmMessages.length,
  });

  return (
    <div
      data-testid="chat-input"
      className="shrink-0 pt-2"
    >
      {/* 첨부 파일 목록 (fileUploadUrl이 있고 파일이 있을 때만) */}
      {effectiveFileUploadUrl && files.length > 0 && (
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

      {/* prompt_suggestion chip — turn 직후 SDK가 제안한 다음 prompt 후보.
          가드: !sending(전송 중 새 turn 시작 불가).
          isDisabled는 의도적으로 사용하지 않는다 — chip의 본질은 "비어있는 입력창에 채우기"이므로
          !text.trim() 가드가 들어가면 chip이 사라진다.
          짧은 탭 → setText, 1초 롱프레스 → 즉시 send. clear는 응답 시작(text_start) 시 자동. */}
      {lastSuggestion && !sending && (
        <SuggestionChip
          text={lastSuggestion}
          onShortTap={(t) => {
            setText(t);
            if (activeSessionKey) setDraft(activeSessionKey, t);
          }}
          onSendImmediate={async (t) => {
            await send(t);
          }}
        />
      )}

      <ChatInputComposer>
        {showInterrupt && (
          <Button
            variant="destructive-outline"
            size="icon"
            onClick={() => void interruptSession()}
            disabled={interruptDisabled}
            title="Stop running conversation"
            aria-label="Stop running conversation"
            className="h-9 w-9 shrink-0 rounded-full sm:h-8 sm:w-8"
          >
            {interrupting ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Square className="h-4 w-4 fill-current" aria-hidden="true" />
            )}
          </Button>
        )}
        {effectiveFileUploadUrl && <PaperclipButton onClick={() => fileInputRef.current?.click()} />}
        <ChatInputEditor
          ref={textareaRef}
          text={text}
          onChangeText={handleChangeText}
          onSend={sendMessage}
          placeholder={mode.placeholder}
          buttonLabel={mode.buttonLabel}
          modeIcon={mode.modeIcon}
          modeLabel={mode.modeLabel}
          borderColor={mode.borderColor}
          buttonVariant={mode.buttonVariant}
          disabled={isDisabled}
          textareaDisabled={textareaDisabled}
        />
      </ChatInputComposer>

      {(error || interruptError) && (
        <div className="chat-tone-danger rounded px-2 py-1 text-xs">
          {error || interruptError}
        </div>
      )}

      {effectiveFileUploadUrl && (
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
