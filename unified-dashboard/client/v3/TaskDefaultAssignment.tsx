import { useEffect, useState } from "react";
import { Button } from "@seosoyoung/soul-ui";

import { AgentNodeAssignmentFields } from "./AgentNodeAssignmentFields";

export function TaskDefaultAssignment({
  agentId,
  nodeId,
  sourceLabel,
  onSave,
}: {
  agentId: string | null;
  nodeId: string | null;
  sourceLabel: string;
  onSave(value: { agentId: string; nodeId: string }): Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draftAgentId, setDraftAgentId] = useState(agentId ?? "");
  const [draftNodeId, setDraftNodeId] = useState(nodeId ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (editing) return;
    setDraftAgentId(agentId ?? "");
    setDraftNodeId(nodeId ?? "");
  }, [agentId, editing, nodeId]);

  const cancel = () => {
    setDraftAgentId(agentId ?? "");
    setDraftNodeId(nodeId ?? "");
    setError(null);
    setEditing(false);
  };
  const save = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await onSave({ agentId: draftAgentId, nodeId: draftNodeId });
      setEditing(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="v3-task-default-assignment">
      <button
        type="button"
        className="v3-task-default-summary"
        aria-label="기본 담당 수정"
        aria-expanded={editing}
        disabled={pending}
        onClick={() => { setError(null); setEditing(true); }}
      >
        <span className="v3-emoji" aria-hidden="true">👤</span>
        <span>{agentId ?? "agent 미지정"}@{nodeId ?? "node 미지정"}</span>
        <small> · {sourceLabel}</small>
      </button>
      {editing ? (
        <div className="v3-task-default-editor">
          <AgentNodeAssignmentFields
            agentId={draftAgentId}
            nodeId={draftNodeId}
            presentation="session"
            disabled={pending}
            onAgentIdChange={setDraftAgentId}
            onNodeIdChange={setDraftNodeId}
            onError={setError}
          />
          {error ? <small role="alert">{error}</small> : null}
          <div className="v3-task-default-actions">
            <Button variant="ghost" disabled={pending} onClick={cancel}>취소</Button>
            <Button disabled={pending || (!draftAgentId.trim() && !draftNodeId.trim())} onClick={() => { void save(); }}>
              {pending ? "저장 중…" : "직접 지정"}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
