import { useEffect, useRef, useState } from "react";
import { Button, MarkdownContent } from "@seosoyoung/soul-ui";

import {
  hasCodePointOverflow,
  TASK_DESCRIPTION_COLLAPSE_LENGTH,
} from "./session-preview";
import "./v3-content-boundary.css";

export function TaskDescriptionPanel({
  markdown,
  onSave,
  ariaLabel = "업무 설명",
  emptyText = "클릭해서 업무 설명을 작성하세요.",
  variant = "default",
  collapsible = true,
  initialEditing = false,
  onEditingChange,
  testId,
}: {
  markdown: string;
  onSave(markdown: string): Promise<void>;
  ariaLabel?: string;
  emptyText?: string;
  variant?: "default" | "compact";
  collapsible?: boolean;
  initialEditing?: boolean;
  onEditingChange?(editing: boolean): void;
  testId?: string;
}) {
  const [editing, setEditing] = useState(initialEditing);
  const [draft, setDraft] = useState(markdown);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const savingRef = useRef(false);

  useEffect(() => {
    if (!editing) {
      setDraft(markdown);
      setExpanded(false);
    }
  }, [editing, markdown]);

  const expandable = collapsible && hasCodePointOverflow(
    markdown,
    TASK_DESCRIPTION_COLLAPSE_LENGTH,
  );

  const changeEditing = (next: boolean) => {
    setEditing(next);
    onEditingChange?.(next);
  };

  const finish = async () => {
    if (savingRef.current) return;
    if (draft === markdown) {
      changeEditing(false);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      await onSave(draft);
      changeEditing(false);
    } catch {
      // Keep the editor and unsaved draft visible so the user can retry.
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <div className="v3-description-editor" data-editor-variant={variant} data-testid={testId}>
        <textarea
          autoFocus
          value={draft}
          aria-label={`${ariaLabel} 마크다운`}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => { void finish(); }}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              void finish();
            }
          }}
        />
        <div>
          <small>마크다운 · ⌘/Ctrl + Enter로 완료</small>
          <Button variant="secondary" disabled={saving} onMouseDown={(event) => event.preventDefault()} onClick={() => { void finish(); }}>
            {saving ? "저장 중…" : "완료"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="v3-description-preview"
      data-expanded={expanded}
      data-editor-variant={variant}
      data-testid={testId}
      onClick={(event) => { if (event.target === event.currentTarget) changeEditing(true); }}
    >
      <button
        type="button"
        className="v3-description-content v3-bounded-markdown"
        aria-label={`${ariaLabel} 편집`}
        onClick={() => changeEditing(true)}
      >
        {markdown ? <MarkdownContent content={markdown} /> : <span className="v3-description-empty">{emptyText}</span>}
      </button>
      <div className="v3-description-actions">
        {expandable ? (
          <Button variant="link" size="sm" onClick={() => setExpanded((value) => !value)}>
            {expanded ? "접기" : "전체 보기"}
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" onClick={() => changeEditing(true)}>편집</Button>
      </div>
    </div>
  );
}
