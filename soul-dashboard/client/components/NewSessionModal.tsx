/**
 * NewSessionModal - 새 세션 생성 모달
 *
 * backdrop + 중앙 모달 형태.
 * 현재 선택된 폴더에 새 세션을 생성한다.
 * 폴더별 draft를 유지하여 모달을 닫았다 열어도 내용이 복원된다.
 */

import { useState, useCallback, useRef, useEffect } from "react";
import {
  useDashboardStore,
  Button,
  type CreateSessionResponse,
} from "@seosoyoung/soul-ui";

/** Soul 서버의 MAX_PROMPT_LENGTH과 일치 (세션 생성 프롬프트의 최대 길이) */
const MAX_LENGTH = 100_000;

/** debounce 간격 (ms) */
const DRAFT_DEBOUNCE_MS = 300;

export function NewSessionModal() {
  const isOpen = useDashboardStore((s) => s.isNewSessionModalOpen);
  const closeModal = useDashboardStore((s) => s.closeNewSessionModal);
  const addOptimisticSession = useDashboardStore((s) => s.addOptimisticSession);
  const selectedFolderId = useDashboardStore((s) => s.selectedFolderId);
  const catalog = useDashboardStore((s) => s.catalog);
  const setDraft = useDashboardStore((s) => s.setDraft);
  const clearDraft = useDashboardStore((s) => s.clearDraft);

  const draftKey = `__draft__${selectedFolderId ?? "null"}`;

  // 폴더명 계산
  const folderName = catalog?.folders.find((f) => f.id === selectedFolderId)?.name ?? "Claude Code";

  // 마운트 시 저장된 draft 복원
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 모달이 열릴 때 draft 복원 + 자동 포커스
  useEffect(() => {
    if (isOpen) {
      const currentDraftKey = `__draft__${useDashboardStore.getState().selectedFolderId ?? "null"}`;
      const savedDraft = useDashboardStore.getState().drafts[currentDraftKey] ?? "";
      setText(savedDraft);
      setError(null);
      setSending(false);
      // 다음 틱에서 포커스 (DOM 렌더링 대기)
      const timer = setTimeout(() => textareaRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  // textarea 높이 자동 조절
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    }
  }, [text]);

  const handleTextChange = useCallback(
    (value: string) => {
      setText(value);
      // debounce로 draft 저장
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        setDraft(draftKey, value);
      }, DRAFT_DEBOUNCE_MS);
    },
    [draftKey, setDraft],
  );

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
      const response = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: trimmed,
          ...(selectedFolderId ? { folderId: selectedFolderId } : {}),
        }),
      });

      if (!response.ok) {
        const body = await response
          .json()
          .catch(() => ({ error: { message: "Unknown error" } }));
        throw new Error(body.error?.message ?? `HTTP ${response.status}`);
      }

      const result: CreateSessionResponse = await response.json();

      // 성공: draft 삭제, 낙관적 추가, 모달 닫기
      clearDraft(draftKey);
      addOptimisticSession(result.agentSessionId, trimmed, selectedFolderId);
      closeModal();
    } catch (err) {
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("Failed to start session");
      }
    } finally {
      setSending(false);
    }
  }, [text, sending, selectedFolderId, addOptimisticSession, clearDraft, draftKey, closeModal]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        submit();
      }
      if (e.key === "Escape") {
        closeModal();
      }
    },
    [submit, closeModal],
  );

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        closeModal();
      }
    },
    [closeModal],
  );

  if (!isOpen) return null;

  const isDisabled = sending || !text.trim();

  return (
    <div
      data-testid="new-session-modal-backdrop"
      className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center"
      onClick={handleBackdropClick}
    >
      <div
        data-testid="new-session-modal"
        className="w-full max-w-lg mx-4 bg-background rounded-lg shadow-xl border border-border animate-in fade-in zoom-in-95 duration-150"
      >
        {/* Header */}
        <div className="px-6 pt-5 pb-3">
          <h2 className="text-base font-semibold text-foreground">New Session</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            in {folderName}
          </p>
        </div>

        {/* Body */}
        <div className="px-6 pb-3">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => handleTextChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="What would you like to work on?"
            disabled={sending}
            rows={3}
            className="w-full bg-input border border-input rounded-lg py-3 px-4 text-[15px] text-foreground font-sans resize-none outline-none min-h-20 max-h-[200px] leading-normal transition-colors duration-150 focus:border-accent-blue/40"
          />

          {/* Error */}
          {error && (
            <div className="text-xs text-accent-red py-2 px-3 rounded-md bg-accent-red/8 mt-2">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex gap-2 justify-end items-center px-6 pb-5">
          <span className="text-[11px] text-muted-foreground/60 flex-1">
            Ctrl+Enter to submit
          </span>
          <Button
            variant="outline"
            onClick={closeModal}
            disabled={sending}
          >
            Cancel
          </Button>
          <Button
            data-testid="new-session-submit"
            onClick={submit}
            disabled={isDisabled}
            className="bg-accent-blue border-accent-blue text-white hover:bg-accent-blue/90"
          >
            {sending ? "Starting..." : "Start"}
          </Button>
        </div>
      </div>
    </div>
  );
}
