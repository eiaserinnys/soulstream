import { useCallback, useMemo, useState } from "react";
import { AtomNodeSelector } from "@seosoyoung/soul-ui";
import { createPageApiClient } from "@seosoyoung/soul-ui/page";

import { AgentNodeAssignmentFields } from "./AgentNodeAssignmentFields";
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
import type { ProjectPageSnapshot } from "./project-page-details";

type EditorState =
  | { kind: "guidance"; blockId: string | null; text: string }
  | { kind: "atom"; blockId: string | null; instance: string; nodeId: string; nodeTitle: string; depth: number; titlesOnly: boolean }
  | { kind: "defaults"; blockId: string | null; agentId: string; nodeId: string }
  | null;

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

  const commit = async () => {
    if (!editor || pending) return;
    setPending(true);
    setMessage(null);
    try {
      if (editor.kind === "guidance") {
        await saveProjectGuidance(api, pageId, editor);
      } else if (editor.kind === "atom") {
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
          <ProjectAtomChip
            key={reference.blockId}
            reference={reference}
            onClick={() => setEditor({
              kind: "atom",
              blockId: reference.blockId,
              instance: reference.instance,
              nodeId: reference.nodeId,
              nodeTitle: reference.nodeTitle,
              depth: reference.depth ?? 3,
              titlesOnly: reference.titlesOnly ?? false,
            })}
          />
        ))}
        {snapshot.sessionDefaults.map((defaults) => (
          <ProjectSessionDefaultChip
            key={defaults.blockId}
            defaults={defaults}
            onClick={() => setEditor({
              kind: "defaults",
              blockId: defaults.blockId,
              agentId: defaults.agentId ?? "",
              nodeId: defaults.nodeId ?? "",
            })}
          />
        ))}
        {empty ? <small>연결된 guidance · atom · 실행 기본값이 없습니다.</small> : null}
      </div>

      <div className="v3-project-context-actions">
        {snapshot.guidance.map((guidance) => (
          <button key={guidance.blockId} type="button" onClick={() => setEditor({ kind: "guidance", ...guidance })}>
            ✦ {guidance.text}
          </button>
        ))}
        <button type="button" onClick={() => setEditor({ kind: "guidance", blockId: null, text: "" })}>＋ guidance</button>
        <button type="button" onClick={() => setEditor({ kind: "atom", blockId: null, instance: "atom", nodeId: "", nodeTitle: "", depth: 3, titlesOnly: false })}>＋ atom</button>
        {snapshot.sessionDefaults.length === 0 ? (
          <button type="button" onClick={() => setEditor({ kind: "defaults", blockId: null, agentId: "", nodeId: "" })}>＋ 기본 에이전트</button>
        ) : null}
      </div>

      {editor?.kind === "guidance" ? (
        <div className="v3-project-context-editor">
          <label>프로젝트 guidance<textarea autoFocus rows={4} value={editor.text} onChange={(event) => setEditor({ ...editor, text: event.target.value })} /></label>
          <EditorActions pending={pending} onCancel={() => setEditor(null)} onSave={commit} />
        </div>
      ) : null}
      {editor?.kind === "atom" ? (
        <div className="v3-project-context-editor">
          <label>atom 노드<AtomNodeSelector value={editor.nodeId} selectedTitle={editor.nodeTitle} disabled={pending} onChange={(nodeId, nodeTitle) => setEditor({ ...editor, nodeId, nodeTitle })} /></label>
          <label>깊이<input type="number" min={1} max={5} value={editor.depth} disabled={pending} onChange={(event) => setEditor({ ...editor, depth: Number(event.target.value) })} /></label>
          <label><input type="checkbox" checked={editor.titlesOnly} disabled={pending} onChange={(event) => setEditor({ ...editor, titlesOnly: event.target.checked })} /> 제목만 포함</label>
          <EditorActions pending={pending} onCancel={() => setEditor(null)} onSave={commit} onDelete={editor.blockId ? () => removeAtom(editor.blockId!) : undefined} />
        </div>
      ) : null}
      {editor?.kind === "defaults" ? (
        <div className="v3-project-context-editor">
          <AgentNodeAssignmentFields agentId={editor.agentId} nodeId={editor.nodeId} disabled={pending} onAgentIdChange={changeDefaultAgent} onNodeIdChange={changeDefaultNode} onError={setMessage} />
          <EditorActions pending={pending} onCancel={() => setEditor(null)} onSave={commit} />
        </div>
      ) : null}
      {message ? <p className={message.includes("실패") ? "v3-project-star-error" : undefined} role="status">{message}</p> : null}
    </section>
  );
}

function EditorActions({ pending, onCancel, onSave, onDelete }: { pending: boolean; onCancel(): void; onSave(): void; onDelete?: () => void }) {
  return (
    <div className="v3-project-context-editor-actions">
      {onDelete ? <button type="button" className="v3-button v3-button--ghost" disabled={pending} onClick={onDelete}>삭제</button> : null}
      <span />
      <button type="button" className="v3-button v3-button--ghost" disabled={pending} onClick={onCancel}>취소</button>
      <button type="button" className="v3-button v3-button--primary" disabled={pending} onClick={onSave}>{pending ? "저장 중…" : "저장"}</button>
    </div>
  );
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
