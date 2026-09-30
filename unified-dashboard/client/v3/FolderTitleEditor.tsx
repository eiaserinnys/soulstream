import { useEffect, useRef, useState } from "react";

import { errorText } from "./v3-dashboard-utils";

export function FolderTitleEditor({
  title,
  onRename,
  headingLevel = 2,
}: {
  title: string;
  onRename(title: string): Promise<void>;
  headingLevel?: 1 | 2;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);

  useEffect(() => {
    if (!editing) setDraft(title);
  }, [editing, title]);

  const cancel = () => {
    setDraft(title);
    setError(null);
    setEditing(false);
  };

  const finish = async () => {
    if (savingRef.current) return;
    const nextTitle = draft.trim();
    if (!nextTitle) {
      setError("폴더 제목을 입력해야 합니다");
      return;
    }
    if (nextTitle === title) {
      cancel();
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await onRename(nextTitle);
      setEditing(false);
    } catch (cause) {
      setError(`폴더 제목 변경 실패 · ${errorText(cause)}`);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const titleButton = <button
    type="button"
    className="v3-task-title-button"
    aria-label="폴더 제목 편집"
    title="클릭해서 폴더 제목 편집"
    onClick={() => {
      setDraft(title);
      setError(null);
      setEditing(true);
    }}
  >{title}</button>;

  return (
    <div className="v3-task-title-editor">
      {editing ? (
        <input
          autoFocus
          className="v3-task-title-input"
          aria-label="폴더 제목 편집"
          value={draft}
          disabled={saving}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => { void finish(); }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              void finish();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              cancel();
            }
          }}
        />
      ) : (
        headingLevel === 1 ? <h1>{titleButton}</h1> : <h2>{titleButton}</h2>
      )}
      {error ? <p className="v3-task-title-error" role="alert">{error}</p> : null}
    </div>
  );
}
