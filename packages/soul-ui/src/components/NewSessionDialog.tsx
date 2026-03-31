/**
 * NewSessionDialog - 새 세션 생성 다이얼로그 (공유 컴포넌트)
 *
 * soul-dashboard와 orchestrator-dashboard 양쪽에서 사용하는 공통 컴포넌트.
 * nodeSelector 슬롯을 통해 오케스트레이터의 노드 선택 드롭다운을 주입할 수 있다.
 */

import { useState, useCallback, useRef, useEffect, type ReactNode } from "react";
import {
  Dialog,
  DialogBackdrop,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogClose,
} from "./ui/dialog";
import { Button } from "./ui/button";

/** Soul 서버의 MAX_PROMPT_LENGTH 기본값 */
const DEFAULT_MAX_LENGTH = 100_000;

/** debounce 간격 (ms) */
const DRAFT_DEBOUNCE_MS = 300;

export interface NewSessionDialogProps {
  /** 다이얼로그 열림 상태 */
  open: boolean;
  /** 열림 상태 변경 콜백 */
  onOpenChange: (open: boolean) => void;
  /** 세션 생성 요청 콜백 */
  onSubmit: (prompt: string) => Promise<void>;
  /** 폴더 선택 슬롯 (soul-dashboard와 orchestrator-dashboard에서 사용) */
  folderSelector?: ReactNode;
  /** 노드 선택 슬롯 (orchestrator-dashboard에서만 사용) */
  nodeSelector?: ReactNode;
  /** 에이전트 선택 슬롯 (orchestrator-dashboard에서만 사용) */
  agentSelector?: ReactNode;
  /** OAuth 토큰 프로필 선택 슬롯 (orchestrator-dashboard에서만 사용) */
  oauthProfileSelector?: ReactNode;
  /** 제출 버튼 비활성 조건 추가 (nodeSelector 미선택 등) */
  submitDisabled?: boolean;
  /** 다이얼로그 타이틀 */
  title?: string;
  /** 부제 (예: 폴더명) */
  subtitle?: string;
  /** 프롬프트 최대 길이 */
  maxLength?: number;
  /** 초기 draft 텍스트 */
  initialDraft?: string;
  /** draft 변경 콜백 (debounced) */
  onDraftChange?: (value: string) => void;
}

export function NewSessionDialog({
  open,
  onOpenChange,
  onSubmit,
  folderSelector,
  nodeSelector,
  agentSelector,
  oauthProfileSelector,
  submitDisabled = false,
  title = "New Session",
  subtitle,
  maxLength = DEFAULT_MAX_LENGTH,
  initialDraft = "",
  onDraftChange,
}: NewSessionDialogProps) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 다이얼로그가 열릴 때 draft 복원 + 자동 포커스
  useEffect(() => {
    if (open) {
      setText(initialDraft);
      setError(null);
      setSending(false);
      const timer = setTimeout(() => textareaRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    }
  }, [open, initialDraft]);

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
      if (onDraftChange) {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
          onDraftChange(value);
        }, DRAFT_DEBOUNCE_MS);
      }
    },
    [onDraftChange],
  );

  const submit = useCallback(async () => {
    if (!text.trim() || sending) return;

    const trimmed = text.trim();
    if (trimmed.length > maxLength) {
      setError(`Prompt too long (${trimmed.length}/${maxLength})`);
      return;
    }

    setSending(true);
    setError(null);

    try {
      await onSubmit(trimmed);
      // 성공 시 텍스트 초기화 (다이얼로그 닫기는 호출자가 처리)
      setText("");
    } catch (err) {
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("Failed to start session");
      }
    } finally {
      setSending(false);
    }
  }, [text, sending, maxLength, onSubmit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        submit();
      }
      if (e.key === "Escape") {
        onOpenChange(false);
      }
    },
    [submit, onOpenChange],
  );

  const isDisabled = sending || !text.trim() || submitDisabled;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogBackdrop className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
      <DialogPopup
        data-testid="new-session-modal"
        className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 mx-4 bg-background rounded-lg shadow-xl border border-border animate-in fade-in zoom-in-95 duration-150"
      >
        {/* Header */}
        <DialogHeader className="px-6 pt-5 pb-3">
          <DialogTitle className="text-base font-semibold text-foreground">
            {title}
          </DialogTitle>
          {subtitle && (
            <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
          )}
        </DialogHeader>

        {/* Body */}
        <div className="px-6 pb-3 flex flex-col gap-3">
          {/* Folder selector slot */}
          {folderSelector && <div className="mb-3">{folderSelector}</div>}

          {/* Node selector slot */}
          {nodeSelector && <div className="mb-3">{nodeSelector}</div>}

          {/* Agent selector slot */}
          {agentSelector && <div className="mb-3">{agentSelector}</div>}

          {/* OAuth profile selector slot */}
          {oauthProfileSelector && <div className="mb-3">{oauthProfileSelector}</div>}

          {/* Prompt textarea */}
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
            <div className="text-xs text-accent-red py-2 px-3 rounded-md bg-accent-red/8">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex gap-2 justify-end items-center px-6 pb-5">
          <span className="text-[11px] text-muted-foreground/60 flex-1">
            Ctrl+Enter to submit
          </span>
          <DialogClose asChild>
            <Button variant="outline" disabled={sending}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            data-testid="new-session-submit"
            onClick={submit}
            disabled={isDisabled}
            className="bg-accent-blue border-accent-blue text-white hover:bg-accent-blue/90"
          >
            {sending ? "Starting..." : "Start"}
          </Button>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
