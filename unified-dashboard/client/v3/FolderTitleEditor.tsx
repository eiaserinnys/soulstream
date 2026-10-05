import { useEffect, useRef, useState, type ReactNode } from "react";

import { errorText } from "./v3-dashboard-utils";

export function FolderTitleEditor({
  title,
  onRename,
  headingLevel = 2,
  variant = "default",
  leading,
}: {
  title: string;
  onRename(title: string): Promise<void>;
  headingLevel?: 1 | 2;
  variant?: "default" | "card";
  leading?: ReactNode;
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

  const titleProps = {
    className: `v3-task-title-button${variant === "card" ? " v3-card-title-button" : ""}`,
    "aria-label": "폴더 제목 편집",
    title: "클릭해서 폴더 제목 편집",
    onClick: () => {
      setDraft(title);
      setError(null);
      setEditing(true);
    },
  };
  // Inline text can wrap below the preceding status control; an inline button
  // remains an atomic box and pushes the entire title onto the next line.
  const titleButton = variant === "card" ? <span {...titleProps} role="button" tabIndex={0}
    onKeyDown={event=>{
      if(event.key==="Enter"||event.key===" "){event.preventDefault();event.stopPropagation();titleProps.onClick();}
    }}>{title}</span> : <button type="button" {...titleProps}>{title}</button>;

  return (
      <div className={`v3-task-title-editor${variant === "card" ? " v3-card-title-editor" : ""}`}>
      {editing ? (
        <input
          autoFocus
          className={`v3-task-title-input${variant === "card" ? " v3-card-title-input" : ""}`}
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
        headingLevel === 1 ? <h1>{leading}{titleButton}</h1> : <h2>{leading}{titleButton}</h2>
      )}
      {error ? <p className="v3-task-title-error" role="alert">{error}</p> : null}
    </div>
  );
}
