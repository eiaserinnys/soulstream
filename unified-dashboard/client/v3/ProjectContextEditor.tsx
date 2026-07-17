import {
  useCallback,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import {
  Button,
  Popover,
  PopoverPopup,
  PopoverTrigger,
} from "@seosoyoung/soul-ui";
import { createPageApiClient } from "@seosoyoung/soul-ui/page";

import {
  ProjectAtomFields,
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
import { TaskDescriptionPanel } from "./TaskDescriptionPanel";

type EditorState =
  | { kind: "atom"; blockId: string | null; instance: "atom" | "atom-nl"; nodeId: string; nodeTitle: string; depth: number; titlesOnly: boolean }
  | { kind: "defaults"; blockId: string | null; agentId: string; nodeId: string }
  | null;
type AtomEditorState = Extract<NonNullable<EditorState>, { kind: "atom" }>;
type DefaultsEditorState = Extract<NonNullable<EditorState>, { kind: "defaults" }>;

export function ProjectContextEditor({
  pageId,
  snapshot,
  onChanged,
}: {
  pageId: string;
  snapshot: ProjectPageSnapshot;
  onChanged(): Promise<void>;
}) {
  const [editor, setEditor] = useState<EditorState>(null);
  const [addingGuidance, setAddingGuidance] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const api = useMemo(() => createPageApiClient(), []);
  const changeDefaultAgent = useCallback((agentId: string) => {
    setEditor((current) => current?.kind === "defaults" ? { ...current, agentId } : current);
  }, []);
  const changeDefaultNode = useCallback((nodeId: string) => {
    setEditor((current) => current?.kind === "defaults" ? { ...current, nodeId } : current);
  }, []);
  const empty = snapshot.guidance.length + snapshot.atomReferences.length + snapshot.sessionDefaults.length === 0;

  const commitGuidance = async (blockId: string | null, text: string) => {
    if (pending) throw new Error("다른 컨텍스트를 저장하는 중입니다.");
    setPending(true);
    setMessage(null);
    try {
      await saveProjectGuidance(api, pageId, { blockId, text });
      await onChanged();
      setMessage("프로젝트 guidance를 저장했습니다.");
    } catch (cause) {
      setMessage(`저장 실패 · ${errorText(cause)}`);
      throw cause;
    } finally {
      setPending(false);
    }
  };

  const commit = async () => {
    if (!editor || pending) return;
    setPending(true);
    setMessage(null);
    try {
      if (editor.kind === "atom") {
        await saveProjectAtomReference(api, pageId, editor);
      } else {
        await saveProjectSessionDefaults(api, pageId, {
          blockId: editor.blockId,
          agentId: editor.agentId || null,
          nodeId: editor.nodeId || null,
        });
      }
      await onChanged();
      setEditor(null);
      setMessage("프로젝트 컨텍스트를 저장했습니다.");
    } catch (cause) {
      setMessage(`저장 실패 · ${errorText(cause)}`);
    } finally {
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
      setMessage("atom 컨텍스트를 제거했습니다.");
    } catch (cause) {
      setMessage(`삭제 실패 · ${errorText(cause)}`);
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="v3-project-context" data-testid="v3-project-context">
      <div className="v3-project-context-row">
        <strong>프로젝트 컨텍스트</strong>
        {snapshot.atomReferences.map((reference) => (
          <Popover
            key={reference.blockId}
            open={editor?.kind === "atom" && editor.blockId === reference.blockId}
            onOpenChange={(open) => setEditor(open ? atomEditor(reference) : null)}
          >
            <PopoverTrigger
              type="button"
              className="v3-project-context-popover-trigger"
              aria-label={`${reference.nodeTitle} atom 설정 편집`}
              aria-haspopup="dialog"
              disabled={pending}
            >
              <ProjectAtomChip reference={reference} />
            </PopoverTrigger>
            <ContextPopover>
              {editor?.kind === "atom" && editor.blockId === reference.blockId ? (
                <AtomEditorFields editor={editor} pending={pending} setEditor={setEditor} onCancel={() => setEditor(null)} onSave={commit} onDelete={() => removeAtom(reference.blockId)} />
              ) : null}
            </ContextPopover>
          </Popover>
        ))}
        {snapshot.sessionDefaults.map((defaults) => (
          <Popover
            key={defaults.blockId}
            open={editor?.kind === "defaults" && editor.blockId === defaults.blockId}
            onOpenChange={(open) => setEditor(open ? defaultsEditor(defaults) : null)}
          >
            <PopoverTrigger
              type="button"
              className="v3-project-context-popover-trigger"
              aria-label="기본 에이전트 설정 편집"
              aria-haspopup="dialog"
              disabled={pending}
            >
              <ProjectSessionDefaultChip defaults={defaults} />
            </PopoverTrigger>
            <ContextPopover>
              {editor?.kind === "defaults" && editor.blockId === defaults.blockId ? (
                <DefaultsEditorFields editor={editor} pending={pending} onAgentIdChange={changeDefaultAgent} onNodeIdChange={changeDefaultNode} onError={setMessage} onCancel={() => setEditor(null)} onSave={commit} />
              ) : null}
            </ContextPopover>
          </Popover>
        ))}
        {empty ? <small>연결된 guidance · atom · 실행 기본값이 없습니다.</small> : null}
      </div>

      <div className="v3-project-guidance-list">
        {snapshot.guidance.map((guidance) => (
          <TaskDescriptionPanel
            key={guidance.blockId}
            markdown={guidance.text}
            ariaLabel="프로젝트 guidance"
            emptyText="프로젝트 guidance를 작성하세요."
            variant="compact"
            testId={`v3-project-guidance-${guidance.blockId}`}
            onSave={(text) => commitGuidance(guidance.blockId, text)}
          />
        ))}
        {addingGuidance ? (
          <TaskDescriptionPanel
            markdown=""
            ariaLabel="새 프로젝트 guidance"
            emptyText="프로젝트 guidance를 작성하세요."
            variant="compact"
            initialEditing
            onEditingChange={(editing) => { if (!editing) setAddingGuidance(false); }}
            onSave={(text) => commitGuidance(null, text)}
          />
        ) : null}
      </div>

      <div className="v3-project-context-actions">
        <button type="button" disabled={pending || addingGuidance} onClick={() => setAddingGuidance(true)}>＋ guidance</button>
        <Popover
          open={editor?.kind === "atom" && editor.blockId === null}
          onOpenChange={(open) => setEditor(open ? emptyAtomEditor() : null)}
        >
          <PopoverTrigger type="button" aria-haspopup="dialog" disabled={pending}>＋ atom</PopoverTrigger>
          <ContextPopover>
            {editor?.kind === "atom" && editor.blockId === null ? (
              <AtomEditorFields editor={editor} pending={pending} setEditor={setEditor} onCancel={() => setEditor(null)} onSave={commit} />
            ) : null}
          </ContextPopover>
        </Popover>
        {snapshot.sessionDefaults.length === 0 ? (
          <Popover
            open={editor?.kind === "defaults" && editor.blockId === null}
            onOpenChange={(open) => setEditor(open ? emptyDefaultsEditor() : null)}
          >
            <PopoverTrigger type="button" aria-haspopup="dialog" disabled={pending}>＋ 기본 에이전트</PopoverTrigger>
            <ContextPopover>
              {editor?.kind === "defaults" && editor.blockId === null ? (
                <DefaultsEditorFields editor={editor} pending={pending} onAgentIdChange={changeDefaultAgent} onNodeIdChange={changeDefaultNode} onError={setMessage} onCancel={() => setEditor(null)} onSave={commit} />
              ) : null}
            </ContextPopover>
          </Popover>
        ) : null}
      </div>
      {message ? <p className={message.includes("실패") ? "v3-project-star-error" : undefined} role="status">{message}</p> : null}
    </section>
  );
}

function ContextPopover({ children }: { children: ReactNode }) {
  return (
    <PopoverPopup align="start" side="bottom" sideOffset={6} className="v3-project-context-popover">
      {children}
    </PopoverPopup>
  );
}

function AtomEditorFields({
  editor,
  pending,
  setEditor,
  onCancel,
  onSave,
  onDelete,
}: {
  editor: AtomEditorState;
  pending: boolean;
  setEditor: Dispatch<SetStateAction<EditorState>>;
  onCancel(): void;
  onSave(): void;
  onDelete?: () => void;
}) {
  return (
    <div className="v3-project-context-editor" data-editor-presentation="popover">
      <ProjectAtomFields
        value={editor}
        disabled={pending}
        onChange={(value) => setEditor({ ...editor, ...value })}
      />
      <EditorActions pending={pending} onCancel={onCancel} onSave={onSave} onDelete={onDelete} />
    </div>
  );
}

function DefaultsEditorFields({
  editor,
  pending,
  onAgentIdChange,
  onNodeIdChange,
  onError,
  onCancel,
  onSave,
}: {
  editor: DefaultsEditorState;
  pending: boolean;
  onAgentIdChange(agentId: string): void;
  onNodeIdChange(nodeId: string): void;
  onError(message: string | null): void;
  onCancel(): void;
  onSave(): void;
}) {
  return (
    <div className="v3-project-context-editor" data-editor-presentation="popover">
      <ProjectSessionDefaultsFields agentId={editor.agentId} nodeId={editor.nodeId} disabled={pending} onAgentIdChange={onAgentIdChange} onNodeIdChange={onNodeIdChange} onError={(message) => onError(message)} />
      <EditorActions pending={pending} onCancel={onCancel} onSave={onSave} />
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
  };
}

function defaultsEditor(defaults: ProjectSessionDefault): DefaultsEditorState {
  return {
    kind: "defaults",
    blockId: defaults.blockId,
    agentId: defaults.agentId ?? "",
    nodeId: defaults.nodeId ?? "",
  };
}

function emptyDefaultsEditor(): DefaultsEditorState {
  return { kind: "defaults", blockId: null, agentId: "", nodeId: "" };
}

function EditorActions({ pending, onCancel, onSave, onDelete }: { pending: boolean; onCancel(): void; onSave(): void; onDelete?: () => void }) {
  return (
    <div className="v3-project-context-editor-actions">
      {onDelete ? <Button variant="destructive-outline" disabled={pending} onClick={onDelete}>삭제</Button> : null}
      <span />
      <Button variant="ghost" disabled={pending} onClick={onCancel}>취소</Button>
      <Button disabled={pending} onClick={onSave}>{pending ? "저장 중…" : "저장"}</Button>
    </div>
  );
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
