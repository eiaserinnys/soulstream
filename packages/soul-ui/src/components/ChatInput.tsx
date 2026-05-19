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
import { useDashboardStore } from "../stores/dashboard-store";
import { FileAttachmentPreview } from "./FileAttachmentPreview";
import { useFileUpload } from "../hooks/useFileUpload";
import { buildLlmHistory } from "./chat/buildLlmHistory";
import { resolveChatInputMode } from "./chat/chatInputMode";
import { PaperclipButton } from "./chat/PaperclipButton";
import { ChatInputEditor } from "./chat/ChatInputEditor";
import { useChatInputSend } from "./chat/useChatInputSend";
import { useTextareaAutoHeight } from "./chat/useTextareaAutoHeight";
import { SuggestionChip } from "./SuggestionChip";

interface ChatInputProps {
  /** 외부에서 주입하는 추가 비활성화 조건 (예: 오케스트레이터에서 노드 dead 상태) */
  additionalDisabled?: boolean;
  /** 다른 노드 소속 세션. true이면 입력/버튼 비활성화 + 안내 문구 표시 */
  isOtherNodeSession?: boolean;
  /**
   * 파일 업로드 URL.
   * 있으면 파일 첨부 버튼이 활성화된다.
   * 없으면 파일 첨부 UI 숨김 (기존 동작 유지).
   * soul-dashboard: "/attachments/sessions"
   * orchestrator-dashboard: "/api/attachments/sessions?nodeId={id}"
   */
  fileUploadUrl?: string;
}

export function ChatInput({ additionalDisabled = false, isOtherNodeSession = false, fileUploadUrl }: ChatInputProps = {}) {
  const activeSessionKey = useDashboardStore((s) => s.activeSessionKey);
  const activeSessionSummary = useDashboardStore((s) => s.activeSessionSummary);
  const tree = useDashboardStore((s) => s.tree);
  const treeVersion = useDashboardStore((s) => s.treeVersion);
  const setActiveSession = useDashboardStore((s) => s.setActiveSession);
  const setDraft = useDashboardStore((s) => s.setDraft);
  const clearDraft = useDashboardStore((s) => s.clearDraft);
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 파일 업로드 훅 — activeSessionKey를 sessionId로 사용 (fileUploadUrl 없으면 noop)
  const { files, isUploading, addFiles, removeFile, resetLocal, uploadedPaths } = useFileUpload({
    uploadUrl: effectiveFileUploadUrl ?? "",
    sessionId: activeSessionKey ?? "",
  });

  // submit 디스패처 훅 — sending / error / abort 관리 + 전략 호출
  const { sending, error, reset, send } = useChatInputSend({
    activeSessionKey,
    tree,
    isFinished,
    isLlmFinished,
    llmProvider: activeSessionSummary?.llmProvider,
    llmModel: activeSessionSummary?.llmModel,
    clientId: activeSessionSummary?.clientId,
    fileUploadUrl: effectiveFileUploadUrl,
    uploadedPaths,
    hasFiles: files.length > 0,
    resetLocal,
    clearDraft,
    setActiveSession,
    onAfterSend: () => setText(""),
  });

  // 세션 변경 시 상태 초기화 & in-flight 요청 취소
  useEffect(() => {
    reset();
    // 세션 전환 시 저장된 draft 복원 (getState()로 직접 읽어 의존성에 drafts 불필요)
    const saved = activeSessionKey
      ? (useDashboardStore.getState().drafts[activeSessionKey] ?? "")
      : "";
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

  const handleChangeText = useCallback(
    (value: string) => {
      setText(value);
      if (activeSessionKey) setDraft(activeSessionKey, value);
    },
    [activeSessionKey, setDraft],
  );

  if (!activeSessionKey) return null;

  const fileUploadDisabled = effectiveFileUploadUrl ? isUploading : false;
  const isDisabled = sending || !text.trim() || additionalDisabled || fileUploadDisabled || isOtherNodeSession;
  const textareaDisabled = sending || additionalDisabled || isOtherNodeSession;

  const mode = resolveChatInputMode({
    isFinished,
    isLlmFinished,
    sending,
    ctxCount: llmMessages.length,
  });

  return (
    <div
      data-testid="chat-input"
      className="border-t border-border p-[var(--panel-inset)] shrink-0"
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
          가드: !isOtherNodeSession(다른 노드 세션은 입력 자체 불가) + !sending(전송 중 새 turn 시작 불가).
          isDisabled는 의도적으로 사용하지 않는다 — chip의 본질은 "비어있는 입력창에 채우기"이므로
          !text.trim() 가드가 들어가면 chip이 사라진다.
          짧은 탭 → setText, 1초 롱프레스 → 즉시 send. clear는 응답 시작(text_start) 시 자동. */}
      {lastSuggestion && !isOtherNodeSession && !sending && (
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

      <div className="flex gap-2">
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
          buttonColor={mode.buttonColor}
          disabled={isDisabled}
          textareaDisabled={textareaDisabled}
        />
      </div>

      {isOtherNodeSession && (
        <div className="text-xs text-muted-foreground py-1 px-2 text-center">
          다른 노드에서 실행된 세션은 재개하거나 개입할 수 없습니다
        </div>
      )}

      {error && (
        <div className="text-xs text-accent-red py-1 px-2 rounded bg-accent-red/8">
          {error}
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
