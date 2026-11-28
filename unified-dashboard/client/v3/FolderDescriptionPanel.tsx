import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState } from "react";
import { DashboardIconCap, MarkdownContent } from "@seosoyoung/soul-ui";
import { useChatTypography } from "@seosoyoung/soul-ui/components/chat/useChatTypography";
import { useTextareaAutoHeight } from "@seosoyoung/soul-ui/components/chat/useTextareaAutoHeight";
import { Check, Pencil } from "lucide-react";

export function FolderDescriptionPanel({
  markdown,
  onSave,
  ariaLabel: ariaLabelProp,
  emptyText: emptyTextProp,
  variant = "default",
  initialEditing = false,
  onEditingChange,
  testId,
}: {
  markdown: string;
  onSave(markdown: string): Promise<void>;
  ariaLabel?: string;
  emptyText?: string;
  variant?: "default" | "compact" | "daily" | "inline";
  initialEditing?: boolean;
  onEditingChange?(editing: boolean): void;
  testId?: string;
}) {
  const { t } = useTranslation();
  const ariaLabel = ariaLabelProp ?? t("folders.description.label");
  const emptyText = emptyTextProp ?? t("folders.description.empty");
  const [editing, setEditing] = useState(initialEditing);
  const [draft, setDraft] = useState(markdown);
  const [saving, setSaving] = useState(false);
  const { chatFontSize, chatTypographyStyle } = useChatTypography();
  const savingRef = useRef(false);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  useTextareaAutoHeight(editorRef, draft, chatFontSize, editing);

  useEffect(() => {
    if (!editing) {
      setDraft(markdown);
    }
  }, [editing, markdown]);

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

  return (
    <div
      className="v3-description-shell v3-chat-surface"
      data-testid={testId}
      style={chatTypographyStyle}
    >
      {editing ? (
        <div className="v3-description-editor control-surface" data-editor-variant={variant}>
          <textarea
            data-slot="chat-input-body"
            rows={1}
            ref={editorRef}
            autoFocus
            value={draft}
            aria-label={t("folders.description.markdown", { label: ariaLabel })}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => { void finish(); }}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void finish();
              }
            }}
          />
          <div className="v3-description-actions">
            <DashboardIconCap size="small"
              label={saving ? t("folders.description.saving", { label: ariaLabel }) : t("folders.description.save", { label: ariaLabel })}
              disabled={saving} aria-busy={saving || undefined}
              onMouseDown={event => event.preventDefault()} onClick={() => { void finish(); }}>
              <Check className="h-4 w-4" aria-hidden="true" />
            </DashboardIconCap>
          </div>
        </div>
      ) : (
        <div
          className="v3-description-preview control-surface"
          data-v3-selectable-content="true"
          data-editor-variant={variant}
          onClick={(event) => { if (event.target === event.currentTarget) changeEditing(true); }}
        >
          <div
            className="v3-description-content"
            onClick={(event) => {
              if (event.target instanceof Element && event.target.closest("a, button")) return;
              changeEditing(true);
            }}
          >
            {markdown ? <MarkdownContent content={markdown} codeBlockLayout="document" /> : <span className="v3-description-empty">{emptyText}</span>}
          </div>
          <div className="v3-description-actions">
            <DashboardIconCap size="small" label={t("folders.description.edit", { label: ariaLabel })} onClick={() => changeEditing(true)}>
              <Pencil className="h-4 w-4" aria-hidden="true" />
            </DashboardIconCap>
          </div>
        </div>
      )}
    </div>
  );
}
