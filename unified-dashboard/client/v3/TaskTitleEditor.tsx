import { useEffect, useRef, useState } from "react";

import { errorText } from "./v3-dashboard-utils";

export function TaskTitleEditor({
  title,
  onRename,
}: {
  title: string;
  onRename(title: string): Promise<void>;
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
      setError("업무 제목을 입력해야 합니다");
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
      setError(`업무 제목 변경 실패 · ${errorText(cause)}`);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <div className="v3-task-title-editor">
      {editing ? (
        <input
          autoFocus
          className="v3-task-title-input"
          aria-label="업무 제목 편집"
          value={draft}
          disabled={saving}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => { void finish(); }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void finish();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              cancel();
            }
          }}
        />
      ) : (
        <h2>
          <button
            type="button"
            className="v3-task-title-button"
            aria-label="업무 제목 편집"
            title="클릭해서 업무 제목 편집"
            onClick={() => {
              setDraft(title);
              setError(null);
              setEditing(true);
            }}
          >
            {title}
          </button>
        </h2>
      )}
      {error ? <p className="v3-task-title-error" role="alert">{error}</p> : null}
    </div>
  );
}
