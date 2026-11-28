import { useTranslation } from "react-i18next";
import { useEffect, useState } from "react";
import { Button, DashboardIconCap } from "@seosoyoung/soul-ui";
import { Pencil } from "lucide-react";

import {
  modelPresetFetchError,
  modelPresetDisplayLabel,
  modelPresetSelectionState,
} from "../lib/model-presets";
import { useNodeModelPresetCatalog } from "../lib/use-node-model-preset-catalog";
import { AgentNodeAssignmentFields } from "./AgentNodeAssignmentFields";

export function FolderDefaultAssignment({
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
  const { t, i18n } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draftAgentId, setDraftAgentId] = useState(agentId ?? "");
  const [draftNodeId, setDraftNodeId] = useState(nodeId ?? "");
  const [draftModelPreset, setDraftModelPreset] = useState(modelPreset ?? "");
  const [modelPresetValid, setModelPresetValid] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const modelPresetCatalog = useNodeModelPresetCatalog(
    nodeId && modelPreset ? nodeId : "",
    setError,
  );
  const catalogMatchesNode = modelPresetCatalog.nodeId === nodeId;
  const modelCatalogStatus = !modelPreset
    ? "idle"
    : catalogMatchesNode
      ? modelPresetCatalog.status
      : "loading";
  const modelSelection = modelPresetSelectionState(
    modelPreset ?? "",
    catalogMatchesNode ? modelPresetCatalog.presets : [],
    modelCatalogStatus === "ready",
    t,
  );
  const modelDisplayLabel = modelPreset
    ? modelPresetDisplayLabel({
        selectedId: modelPreset,
        preset: modelSelection.preset,
        status: modelCatalogStatus,
        missingLabel: t("folders.assignment.checkModel"),
      }, t, i18n.language)
    : t("folders.assignment.noModel");

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
          <span>{nodeId ?? t("folders.assignment.noNode")}</span>
          <span aria-hidden="true">·</span>
          <span>{agentId ?? t("folders.assignment.noAgent")}</span>
          <span aria-hidden="true">·</span>
          <span
            data-model-preset-state={modelCatalogStatus}
            className={modelSelection.preset?.reason === "quota_exhausted" ? "text-destructive" : undefined}
            title={modelSelection.warning ?? undefined}
          >
            {modelDisplayLabel}
          </span>
        </span>
        <DashboardIconCap
          className="v3-task-default-edit"
          label={t("folders.assignment.edit")}
          aria-expanded={editing}
          disabled={pending || editing}
          onClick={() => {
            setError(modelPresetCatalog.status === "error" ? modelPresetFetchError(t) : null);
            setEditing(true);
          }}
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
            modelPresetCatalog={modelPresetCatalog}
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
            <Button variant="ghost" disabled={pending} onClick={cancel}>{t("folders.common.cancel")}</Button>
            <Button
              disabled={
                pending
                || !modelPresetValid
                || (!draftAgentId.trim() && !draftNodeId.trim())
              }
              onClick={() => { void save(); }}
            >
              {pending ? t("folders.common.saving") : t("folders.common.save")}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
