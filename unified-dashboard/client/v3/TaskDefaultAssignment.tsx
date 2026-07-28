import { useEffect, useState } from "react";
import { Button } from "@seosoyoung/soul-ui";

import { AgentNodeAssignmentFields } from "./AgentNodeAssignmentFields";

export function TaskDefaultAssignment({
  agentId,
  nodeId,
  modelPreset,
  sourceLabel,
  onSave,
}: {
  agentId: string | null;
  nodeId: string | null;
  modelPreset: string | null;
  sourceLabel: string;
  onSave(value: { agentId: string; nodeId: string; modelPreset: string }): Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draftAgentId, setDraftAgentId] = useState(agentId ?? "");
  const [draftNodeId, setDraftNodeId] = useState(nodeId ?? "");
  const [draftModelPreset, setDraftModelPreset] = useState(modelPreset ?? "");
  const [modelPresetValid, setModelPresetValid] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (editing) return;
    setDraftAgentId(agentId ?? "");
    setDraftNodeId(nodeId ?? "");
    setDraftModelPreset(modelPreset ?? "");
  }, [agentId, editing, modelPreset, nodeId]);

  const cancel = () => {
    setDraftAgentId(agentId ?? "");
    setDraftNodeId(nodeId ?? "");
    setDraftModelPreset(modelPreset ?? "");
    setModelPresetValid(true);
    setError(null);
    setEditing(false);
  };
  const save = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await onSave({
        agentId: draftAgentId,
        nodeId: draftNodeId,
        modelPreset: draftModelPreset,
      });
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
        {modelPreset ? <small> · 모델 지정</small> : null}
        <small> · {sourceLabel}</small>
      </button>
      {editing ? (
        <div className="v3-task-default-editor">
          <AgentNodeAssignmentFields
            agentId={draftAgentId}
            nodeId={draftNodeId}
            modelPreset={draftModelPreset}
            presentation="session"
            disabled={pending}
            onAgentIdChange={setDraftAgentId}
            onNodeIdChange={setDraftNodeId}
            onModelPresetChange={setDraftModelPreset}
            onModelPresetValidityChange={setModelPresetValid}
            onError={setError}
          />
          {error ? <small role="alert">{error}</small> : null}
          <div className="v3-task-default-actions">
            <Button variant="ghost" disabled={pending} onClick={cancel}>취소</Button>
            <Button
              disabled={
                pending
                || !modelPresetValid
                || (!draftAgentId.trim() && !draftNodeId.trim())
              }
              onClick={() => { void save(); }}
            >
              {pending ? "저장 중…" : "직접 지정"}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
