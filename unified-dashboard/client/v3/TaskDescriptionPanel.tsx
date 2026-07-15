import { useEffect, useRef, useState } from "react";
import { Button, MarkdownContent } from "@seosoyoung/soul-ui";

export function TaskDescriptionPanel({
  markdown,
  onSave,
  ariaLabel = "업무 설명",
  emptyText = "클릭해서 업무 설명을 작성하세요.",
  variant = "default",
  initialEditing = false,
  onEditingChange,
  testId,
}: {
  markdown: string;
  onSave(markdown: string): Promise<void>;
  ariaLabel?: string;
  emptyText?: string;
  variant?: "default" | "compact";
  initialEditing?: boolean;
  onEditingChange?(editing: boolean): void;
  testId?: string;
}) {
  const [editing, setEditing] = useState(initialEditing);
  const [draft, setDraft] = useState(markdown);
  const [saving, setSaving] = useState(false);
  const [editorMinHeight, setEditorMinHeight] = useState<number | null>(null);
  const savingRef = useRef(false);
  const previewRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!editing) {
      setDraft(markdown);
    }
  }, [editing, markdown]);

  const changeEditing = (next: boolean) => {
    if (next && !editing) {
      const previewHeight = previewRef.current?.offsetHeight ?? 0;
      setEditorMinHeight(previewHeight > 0 ? previewHeight : null);
    } else if (!next) {
      setEditorMinHeight(null);
    }
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

  return (
    <div
      className="v3-description-shell"
      data-testid={testId}
      style={editorMinHeight ? { minHeight: `${editorMinHeight}px` } : undefined}
    >
      {editing ? (
        <div className="v3-description-editor" data-editor-variant={variant}>
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
            <Button variant="secondary" disabled={saving} onMouseDown={(event) => event.preventDefault()} onClick={() => { void finish(); }}>
              {saving ? "저장 중…" : "완료"}
            </Button>
          </div>
        </div>
      ) : (
        <div
          ref={previewRef}
          className="v3-description-preview"
          data-editor-variant={variant}
          onClick={(event) => { if (event.target === event.currentTarget) changeEditing(true); }}
        >
          <button
            type="button"
            className="v3-description-content"
            aria-label={`${ariaLabel} 편집`}
            onClick={() => changeEditing(true)}
          >
            {markdown ? <MarkdownContent content={markdown} /> : <span className="v3-description-empty">{emptyText}</span>}
          </button>
          <div className="v3-description-actions">
            <Button variant="ghost" size="sm" onClick={() => changeEditing(true)}>편집</Button>
          </div>
        </div>
      )}
    </div>
  );
}
