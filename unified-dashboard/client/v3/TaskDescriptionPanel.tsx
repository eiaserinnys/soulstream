import { useEffect, useRef, useState } from "react";
import { MarkdownContent } from "@seosoyoung/soul-ui/components/MarkdownContent";

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
  const savingRef = useRef(false);

  useEffect(() => {
    if (!editing) setDraft(markdown);
  }, [editing, markdown]);

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
          <button type="button" className="v3-button v3-button--soft" disabled={saving} onMouseDown={(event) => event.preventDefault()} onClick={() => { void finish(); }}>
            {saving ? "저장 중…" : "완료"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <button type="button" className="v3-description-preview" onClick={() => setEditing(true)}>
      <span className="v3-description-edit" aria-hidden="true">✎</span>
      {markdown ? <MarkdownContent content={markdown} /> : <span className="v3-description-empty">클릭해 업무 설명을 작성하세요.</span>}
    </button>
  );
}
