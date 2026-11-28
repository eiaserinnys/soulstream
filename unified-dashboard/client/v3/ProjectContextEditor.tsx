import { folderErrorText } from "./folder-messages";
import { useTranslation } from "react-i18next";
import { FilePlus2, Network, Bot } from "lucide-react";
import {
  useCallback,
  useMemo,
  useState,
  useRef,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import {
  Button,
  DashboardIconCap,
  Popover,
  PopoverPopup,
  PopoverTrigger,
} from "@seosoyoung/soul-ui";
import { createPageApiClient } from "@seosoyoung/soul-ui/page";

import {
  ProjectAtomFields,
  isProjectAtomValid,
  ProjectSessionDefaultsFields,
} from "./ProjectContextFormFields";
import {
  ProjectAtomChip,
  ProjectSessionDefaultChip,
} from "./ProjectContextChips";
import {
  deleteProjectContextBlock,
  saveProjectAtomReference,
  saveProjectGuidance,
  saveProjectSessionDefaults,
} from "./project-context-actions";
import type {
  ProjectAtomReference,
  ProjectPageSnapshot,
  ProjectSessionDefault,
} from "./project-page-details";
import { FolderDescriptionPanel } from "./FolderDescriptionPanel";

type EditorState =
  | { kind: "atom"; blockId: string | null; instance: "atom" | "atom-nl"; nodeId: string; nodeTitle: string; depth: number; titlesOnly: boolean; limit: number | null; mode?: "full" | "index" | "titles" }
  | {
      kind: "defaults";
      blockId: string | null;
      agentId: string;
      nodeId: string;
      modelPreset: string;
    }
  | null;
type AtomEditorState = Extract<NonNullable<EditorState>, { kind: "atom" }>;
type DefaultsEditorState = Extract<NonNullable<EditorState>, { kind: "defaults" }>;

export function ProjectContextEditor({
  api: suppliedApi, request, assignment, initialEditor,
  pageId,
  snapshot,
  onChanged,
}: {
  initialEditor?: "atom-add" | "atom-edit" | "defaults-add" | "defaults-edit";
  api?: import("@seosoyoung/soul-ui/page").PageApiClient;
  request?: typeof fetch;
  assignment?: import("./AgentNodeAssignmentFields").AssignmentData;
  pageId: string;
  snapshot: ProjectPageSnapshot;
  onChanged(): Promise<void>;
}) {
  const { t } = useTranslation();
  const [editor, setEditor] = useState<EditorState>(()=> initialEditor === "atom-add" ? emptyAtomEditor() : initialEditor === "atom-edit" && snapshot.atomReferences[0] ? atomEditor(snapshot.atomReferences[0]) : initialEditor === "defaults-add" ? emptyDefaultsEditor() : initialEditor === "defaults-edit" && snapshot.sessionDefaults[0] ? defaultsEditor(snapshot.sessionDefaults[0]) : null);
  const [addingGuidance, setAddingGuidance] = useState(false);
  const committing = useRef(false);
  const [pending, setPending] = useState(false);
  const [modelPresetValid, setModelPresetValid] = useState(true);
  const [message, setMessage] = useState<{ text: string; failed?: boolean } | null>(null);
  const api = useMemo(() => suppliedApi ?? createPageApiClient(), [suppliedApi]);
  const changeDefaultAgent = useCallback((agentId: string) => {
    setEditor((current) => current?.kind === "defaults" ? { ...current, agentId } : current);
  }, []);
  const changeDefaultNode = useCallback((nodeId: string) => {
    setEditor((current) => current?.kind === "defaults"
      ? { ...current, nodeId, modelPreset: "" }
      : current);
    setModelPresetValid(true);
  }, []);
  const changeDefaultModelPreset = useCallback((modelPreset: string) => {
    setEditor((current) => current?.kind === "defaults"
      ? { ...current, modelPreset }
      : current);
  }, []);
  const empty = snapshot.guidance.length + snapshot.atomReferences.length + snapshot.sessionDefaults.length === 0;

  const commitGuidance = async (blockId: string | null, text: string) => {
    if (pending) throw new Error(t("folders.context.saveInProgress"));
    setPending(true);
    setMessage(null);
    try {
      await saveProjectGuidance(api, pageId, { blockId, text });
      await onChanged();
      setMessage({ text: t("folders.context.guidanceSaved") });
    } catch (cause) {
      setMessage({ text: t("folders.common.saveError", { detail: folderErrorText(t, cause) }), failed: true });
      throw cause;
    } finally {
      committing.current = false;
      setPending(false);
    }
  };

  const commit = async () => {
    if (!editor || committing.current || (editor.kind === "defaults" && !modelPresetValid) || (editor.kind === "atom" && !isProjectAtomValid(editor))) return;
    committing.current = true;
    setPending(true);
    setMessage(null);
    try {
      if (editor.kind === "atom") {
        const duplicate = snapshot.atomReferences.find(item => item.instance === editor.instance && item.nodeId === editor.nodeId);
        await saveProjectAtomReference(api, pageId, { ...editor, blockId: duplicate?.blockId ?? editor.blockId });
      } else if (!editor.agentId && !editor.nodeId && !editor.modelPreset) {
        if (editor.blockId) await deleteProjectContextBlock(api, pageId, editor.blockId);
      } else {
        await saveProjectSessionDefaults(api, pageId, {
          blockId: editor.blockId,
          agentId: editor.agentId || null,
          nodeId: editor.nodeId || null,
          modelPreset: editor.modelPreset || null,
        });
      }
      await onChanged();
      setEditor(null);
      setMessage({ text: t("folders.context.saved") });
    } catch (cause) {
      setMessage({ text: t("folders.common.saveError", { detail: folderErrorText(t, cause) }), failed: true });
    } finally {
      committing.current = false;
      setPending(false);
    }
  };

  const removeAtom = async (blockId: string) => {
    if (pending) return;
    setPending(true);
    setMessage(null);
    try {
      await deleteProjectContextBlock(api, pageId, blockId);
      await onChanged();
      setEditor(null);
      setMessage({ text: t("folders.context.atomRemoved") });
    } catch (cause) {
      setMessage({ text: t("folders.common.deleteError", { detail: folderErrorText(t, cause) }), failed: true });
    } finally {
      committing.current = false;
      setPending(false);
    }
  };

  return (
    <section className="v3-project-context" data-testid="v3-project-context">
      <div className="v3-detail-section-head">
        <h3>{t("folders.context.title")}</h3><span className="v3-spacer"/>
      <div className="v3-folder-header-actions">
        <DashboardIconCap size="small" label={t("folders.context.addGuidance")} disabled={pending || addingGuidance} onClick={() => setAddingGuidance(true)}><FilePlus2 className="h-4 w-4"/></DashboardIconCap>
        <Popover
          open={editor?.kind === "atom" && editor.blockId === null}
          onOpenChange={(open) => { if (!committing.current) setEditor(open ? emptyAtomEditor() : null); }}
        >
          <PopoverTrigger render={<DashboardIconCap size="small" label={t("folders.context.addAtom")} disabled={pending}><Network className="h-4 w-4"/></DashboardIconCap>} aria-haspopup="dialog"/>
          <ContextPopover>
            {editor?.kind === "atom" && editor.blockId === null ? (
              <AtomEditorFields request={request} editor={editor} pending={pending} setEditor={setEditor} onCancel={() => setEditor(null)} onSave={commit} />
            ) : null}
          </ContextPopover>
        </Popover>
        {snapshot.sessionDefaults.length === 0 ? (
          <Popover
            open={editor?.kind === "defaults" && editor.blockId === null}
            onOpenChange={(open) => {
              if (committing.current) return;
              setModelPresetValid(true);
              setEditor(open ? emptyDefaultsEditor() : null);
            }}
          >
            <PopoverTrigger render={<DashboardIconCap size="small" label={t("folders.context.addDefaultAgent")} disabled={pending}><Bot className="h-4 w-4"/></DashboardIconCap>} aria-haspopup="dialog"/>
            <ContextPopover>
              {editor?.kind === "defaults" && editor.blockId === null ? (
                <DefaultsEditorFields assignment={assignment} editor={editor} pending={pending} modelPresetValid={modelPresetValid} onAgentIdChange={changeDefaultAgent} onNodeIdChange={changeDefaultNode} onModelPresetChange={changeDefaultModelPreset} onModelPresetValidityChange={setModelPresetValid} onError={text => setMessage(text ? { text, failed: true } : null)} onCancel={() => setEditor(null)} onSave={commit} />
              ) : null}
            </ContextPopover>
          </Popover>
        ) : null}
      </div>
      </div>
      <div className="v3-project-context-row">
        {snapshot.atomReferences.map((reference) => (
          <Popover
            key={reference.blockId}
            open={editor?.kind === "atom" && editor.blockId === reference.blockId}
            onOpenChange={(open) => { if (!committing.current) setEditor(open ? atomEditor(reference) : null); }}
          >
            <PopoverTrigger
              type="button"
              className="v3-project-context-popover-trigger"
              aria-label={t("folders.context.editAtom", { name: reference.nodeTitle })}
              aria-haspopup="dialog"
              disabled={pending}
            >
              <ProjectAtomChip reference={reference} />
            </PopoverTrigger>
            <ContextPopover>
              {editor?.kind === "atom" && editor.blockId === reference.blockId ? (
                <AtomEditorFields request={request} editor={editor} pending={pending} setEditor={setEditor} onCancel={() => setEditor(null)} onSave={commit} onDelete={() => removeAtom(reference.blockId)} />
              ) : null}
            </ContextPopover>
          </Popover>
        ))}
        {snapshot.sessionDefaults.map((defaults) => (
          <Popover
            key={defaults.blockId}
            open={editor?.kind === "defaults" && editor.blockId === defaults.blockId}
            onOpenChange={(open) => {
              if (committing.current) return;
              setModelPresetValid(true);
              setEditor(open ? defaultsEditor(defaults) : null);
            }}
          >
            <PopoverTrigger
              type="button"
              className="v3-project-context-popover-trigger"
              aria-label={t("folders.context.editDefaultAgent")}
              aria-haspopup="dialog"
              disabled={pending}
            >
              <ProjectSessionDefaultChip defaults={defaults} />
            </PopoverTrigger>
            <ContextPopover>
              {editor?.kind === "defaults" && editor.blockId === defaults.blockId ? (
                <DefaultsEditorFields assignment={assignment} editor={editor} pending={pending} modelPresetValid={modelPresetValid} onAgentIdChange={changeDefaultAgent} onNodeIdChange={changeDefaultNode} onModelPresetChange={changeDefaultModelPreset} onModelPresetValidityChange={setModelPresetValid} onError={text => setMessage(text ? { text, failed: true } : null)} onCancel={() => setEditor(null)} onSave={commit} />
              ) : null}
            </ContextPopover>
          </Popover>
        ))}
        {empty ? <small>{t("folders.context.empty")}</small> : null}
      </div>

      <div className="v3-project-guidance-list">
        {snapshot.guidance.map((guidance) => (
          <FolderDescriptionPanel
            key={guidance.blockId}
            markdown={guidance.text}
            ariaLabel={t("folders.context.guidanceLabel")}
            emptyText={t("folders.context.guidanceEmpty")}
            variant="compact"
            testId={`v3-project-guidance-${guidance.blockId}`}
            onSave={(text) => commitGuidance(guidance.blockId, text)}
          />
        ))}
        {addingGuidance ? (
          <FolderDescriptionPanel
            markdown=""
            ariaLabel={t("folders.context.newGuidance")}
            emptyText={t("folders.context.guidanceEmpty")}
            variant="compact"
            initialEditing
            onEditingChange={(editing) => { if (!editing) setAddingGuidance(false); }}
            onSave={(text) => commitGuidance(null, text)}
          />
        ) : null}
      </div>


      {message ? <p className={message.failed ? "v3-project-star-error" : undefined} role="status" data-v3-selectable-content="true">{message.text}</p> : null}
    </section>
  );
}

function ContextPopover({ children }: { children: ReactNode }) {
  return (
    <PopoverPopup align="start" side="bottom" sideOffset={6} collisionPadding={12} initialFocus finalFocus className="v3-project-context-popover">
      {children}
    </PopoverPopup>
  );
}

function AtomEditorFields({
  request,
  editor,
  pending,
  setEditor,
  onCancel,
  onSave,
  onDelete,
}: {
  request?: typeof fetch;
  editor: AtomEditorState;
  pending: boolean;
  setEditor: Dispatch<SetStateAction<EditorState>>;
  onCancel(): void;
  onSave(): void;
  onDelete?: () => void;
}) {
  const [open, setOpen] = useState(editor.instance === "atom");
  const [status, setStatus] = useState<"loading" | "ready" | "error">("ready");
  return (
    <div className="v3-project-context-editor" data-editor-presentation="popover"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        event.currentTarget.querySelector<HTMLButtonElement>('[data-slot="atom-node-selector-trigger"]')?.focus();
      }}
    >
      <ProjectAtomFields request={request} presentation="inline"
        selectorOpen={open} onSelectorOpenChange={setOpen} onSelectorStatusChange={setStatus}
        value={editor}
        disabled={pending}
        onChange={(value) => setEditor({ ...editor, ...value })}
      />
      <EditorActions pending={pending} invalid={open || status !== "ready" || !isProjectAtomValid(editor)} onCancel={onCancel} onSave={onSave} onDelete={onDelete} />
    </div>
  );
}

function DefaultsEditorFields({
  assignment,
  editor,
  pending,
  onAgentIdChange,
  onNodeIdChange,
  onModelPresetChange,
  onModelPresetValidityChange,
  modelPresetValid,
  onError,
  onCancel,
  onSave,
}: {
  assignment?: import("./AgentNodeAssignmentFields").AssignmentData;
  editor: DefaultsEditorState;
  pending: boolean;
  modelPresetValid: boolean;
  onAgentIdChange(agentId: string): void;
  onNodeIdChange(nodeId: string): void;
  onModelPresetChange(modelPreset: string): void;
  onModelPresetValidityChange(valid: boolean): void;
  onError(message: string | null): void;
  onCancel(): void;
  onSave(): void;
}) {
  return (
    <div className="v3-project-context-editor" data-editor-presentation="popover">
      <ProjectSessionDefaultsFields assignment={assignment}
        agentId={editor.agentId}
        nodeId={editor.nodeId}
        modelPreset={editor.modelPreset}
        disabled={pending}
        onAgentIdChange={onAgentIdChange}
        onNodeIdChange={onNodeIdChange}
        onModelPresetChange={onModelPresetChange}
        onModelPresetValidityChange={onModelPresetValidityChange}
        onError={(message) => onError(message)}
      />
      <EditorActions pending={pending} invalid={!modelPresetValid} onCancel={onCancel} onSave={onSave} />
    </div>
  );
}

function atomEditor(reference: ProjectAtomReference): AtomEditorState {
  return {
    kind: "atom",
    blockId: reference.blockId,
    instance: reference.instance,
    nodeId: reference.nodeId,
    nodeTitle: reference.nodeTitle,
    depth: reference.depth ?? 3,
    titlesOnly: reference.titlesOnly ?? false,
    limit: reference.limit ?? null,
    ...(reference.mode !== undefined ? { mode: reference.mode } : {}),
  };
}

function emptyAtomEditor(): AtomEditorState {
  return {
    kind: "atom",
    blockId: null,
    instance: "atom",
    nodeId: "",
    nodeTitle: "",
    depth: 3,
    titlesOnly: false,
    limit: null,
  };
}

function defaultsEditor(defaults: ProjectSessionDefault): DefaultsEditorState {
  return {
    kind: "defaults",
    blockId: defaults.blockId,
    agentId: defaults.agentId ?? "",
    nodeId: defaults.nodeId ?? "",
    modelPreset: defaults.modelPreset ?? "",
  };
}

function emptyDefaultsEditor(): DefaultsEditorState {
  return {
    kind: "defaults",
    blockId: null,
    agentId: "",
    nodeId: "",
    modelPreset: "",
  };
}

function EditorActions({ pending, invalid = false, onCancel, onSave, onDelete }: { pending: boolean; invalid?: boolean; onCancel(): void; onSave(): void; onDelete?: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="v3-project-context-editor-actions">
      {onDelete ? <Button variant="destructive-outline" disabled={pending} onClick={onDelete}>{t("folders.common.delete")}</Button> : null}
      <span />
      <Button variant="ghost" disabled={pending} onClick={onCancel}>{t("folders.common.cancel")}</Button>
      <Button disabled={pending || invalid} onClick={onSave}>{pending ? t("folders.common.saving") : t("folders.common.save")}</Button>
    </div>
  );
}
