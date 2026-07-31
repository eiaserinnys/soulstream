import { useEffect, useState } from "react";
import { Button, DashboardIconCap } from "@seosoyoung/soul-ui";
import { Pencil } from "lucide-react";

import { AgentNodeAssignmentFields } from "./AgentNodeAssignmentFields";

export function TaskDefaultAssignment({
  agentId,
  nodeId,
  modelPreset,
  onSave,
}: {
  agentId: string | null;
  nodeId: string | null;
  modelPreset: string | null;
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
      <div
        className="v3-task-default-summary"
        data-testid="task-default-summary"
      >
        <span className="v3-emoji" aria-hidden="true">👤</span>
        <span className="v3-task-default-values">
          <span>{nodeId ?? "노드 미지정"}</span>
          <span aria-hidden="true">·</span>
          <span>{agentId ?? "에이전트 미지정"}</span>
          <span aria-hidden="true">·</span>
          <span>{modelPreset ?? "모델 미지정"}</span>
        </span>
        <DashboardIconCap
          className="v3-task-default-edit"
          label="기본 담당 편집"
          aria-expanded={editing}
          disabled={pending || editing}
          onClick={() => { setError(null); setEditing(true); }}
        >
          <Pencil className="h-4 w-4" aria-hidden="true" />
        </DashboardIconCap>
      </div>
      {editing ? (
        <div className="v3-task-default-editor">
          <AgentNodeAssignmentFields
            agentId={draftAgentId}
            nodeId={draftNodeId}
            modelPreset={draftModelPreset}
            presentation="session"
            layout="compact-row"
            disabled={pending}
            onAgentIdChange={setDraftAgentId}
            onNodeIdChange={(value) => {
              setDraftNodeId(value);
              setDraftModelPreset("");
              setModelPresetValid(true);
            }}
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
              {pending ? "저장 중…" : "저장"}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
