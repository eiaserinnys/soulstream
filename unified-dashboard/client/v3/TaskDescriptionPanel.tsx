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
}: {
  markdown: string;
  onSave(markdown: string): Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
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

  const expandable = hasCodePointOverflow(
    markdown,
    TASK_DESCRIPTION_COLLAPSE_LENGTH,
  );

  const finish = async () => {
    if (savingRef.current) return;
    if (draft === markdown) {
      setEditing(false);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      await onSave(draft);
      setEditing(false);
    } catch {
      // Keep the editor and unsaved draft visible so the user can retry.
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <div className="v3-description-editor">
        <textarea
          autoFocus
          value={draft}
          aria-label="업무 설명 마크다운"
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
      onClick={(event) => { if (event.target === event.currentTarget) setEditing(true); }}
    >
      <button
        type="button"
        className="v3-description-content v3-bounded-markdown"
        aria-label="업무 설명 편집"
        onClick={() => setEditing(true)}
      >
        {markdown ? <MarkdownContent content={markdown} /> : <span className="v3-description-empty">클릭해서 업무 설명을 작성하세요.</span>}
      </button>
      <div className="v3-description-actions">
        {expandable ? (
          <Button variant="link" size="sm" onClick={() => setExpanded((value) => !value)}>
            {expanded ? "접기" : "전체 보기"}
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>편집</Button>
      </div>
    </div>
  );
}
