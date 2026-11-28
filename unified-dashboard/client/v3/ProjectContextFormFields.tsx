import { useTranslation } from "react-i18next";
import { useId } from "react";
import { AtomNodeSelector } from "@seosoyoung/soul-ui";

import { AgentNodeAssignmentFields } from "./AgentNodeAssignmentFields";

export interface ProjectAtomFieldValue {
  instance: "atom" | "atom-nl";
  nodeId: string;
  nodeTitle: string;
  depth: number;
  titlesOnly: boolean;
  limit?: number | null;
  mode?: "full" | "index" | "titles";
}

export function ProjectAtomFields({
  request,
  value,
  disabled,
  onChange,
  presentation = "popup",
  selectorOpen, onSelectorOpenChange, onSelectorStatusChange, supportsLimit = true,
}: {
  request?: typeof fetch;
  supportsLimit?: boolean;
  presentation?: "popup" | "inline";
  selectorOpen?: boolean;
  onSelectorOpenChange?(open: boolean): void;
  onSelectorStatusChange?(status: "loading" | "ready" | "error"): void;
  value: ProjectAtomFieldValue;
  disabled: boolean;
  onChange(value: ProjectAtomFieldValue): void;
}) {
  const { t } = useTranslation();
  const nodeLabelId = useId();
  const selector = (
    <AtomNodeSelector presentation={presentation} request={request}
      value={value.nodeId}
      selectedTitle={value.nodeTitle}
      disabled={disabled || value.instance !== "atom"}
      open={selectorOpen}
      onOpenChange={onSelectorOpenChange}
      onStatusChange={onSelectorStatusChange}
      onChange={(nodeId, nodeTitle) => onChange({ ...value, nodeId, nodeTitle })}
    />
  );
  return (
    <div className="v3-project-context-fields">
      <label>
        {t("folders.atom.instance")}
        <span>{value.instance}</span>
        <small>{t("folders.atom.browseHint")}</small>
      </label>
      {presentation === "inline" ? (
        <div className="v3-project-context-node-field" role="group" aria-labelledby={nodeLabelId}>
          <span id={nodeLabelId}>{t("folders.atom.node")}</span>
          {selector}
        </div>
      ) : <label>{t("folders.atom.node")}{selector}</label>}
      <label>
        {t("folders.atom.depth")}
        <input
          type="number"
          min={1}
          max={5}
          value={value.depth}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, depth: Number(event.target.value) })}
        />
      </label>
      {supportsLimit ? <label>
        {t("folders.atom.recentCount")}
        <input
          type="number"
          min={1}
          value={value.limit ?? ""}
          placeholder={t("folders.atom.all")}
          aria-label={t("folders.atom.recentCountLabel")}
          disabled={disabled}
          onChange={(event) => onChange({
            ...value,
            limit: event.target.value === "" ? null : Number(event.target.value),
          })}
        />
      </label> : null}
      <label>
        {t("folders.atom.renderMode")}
        <select
          aria-label={t("folders.atom.renderModeLabel")}
          value={value.mode ?? ""}
          disabled={disabled}
          onChange={(event) => {
            const mode = event.target.value as "" | "full" | "index" | "titles";
            const next = { ...value, mode: mode || undefined };
            if (!next.mode) delete next.mode;
            onChange(next);
          }}
        >
          <option value="">{t("folders.atom.existingMode")}</option>
          <option value="full">{t("folders.atom.full")}</option>
          <option value="index">{t("folders.atom.index")}</option>
          <option value="titles">{t("folders.atom.titles")}</option>
        </select>
      </label>
      <label>
        <input
          type="checkbox"
          checked={value.titlesOnly}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, titlesOnly: event.target.checked })}
        />
        {t("folders.atom.titlesOnly")} </label>
    </div>
  );
}

export function ProjectSessionDefaultsFields({
  assignment,
  agentId,
  nodeId,
  modelPreset,
  disabled,
  onAgentIdChange,
  onNodeIdChange,
  onModelPresetChange,
  onModelPresetValidityChange,
  onError,
}: {
  assignment?: import("./AgentNodeAssignmentFields").AssignmentData;
  agentId: string;
  nodeId: string;
  modelPreset: string;
  disabled: boolean;
  onAgentIdChange(agentId: string): void;
  onNodeIdChange(nodeId: string): void;
  onModelPresetChange(modelPreset: string): void;
  onModelPresetValidityChange?(valid: boolean): void;
  onError(message: string): void;
}) {
  return (
    <div className="v3-project-context-fields">
      <AgentNodeAssignmentFields data={assignment}
        agentId={agentId}
        nodeId={nodeId}
        modelPreset={modelPreset}
        disabled={disabled}
        onAgentIdChange={onAgentIdChange}
        onNodeIdChange={onNodeIdChange}
        onModelPresetChange={onModelPresetChange}
        onModelPresetValidityChange={onModelPresetValidityChange}
        onError={onError}
      />
    </div>
  );
}

export function isProjectAtomValid(value: ProjectAtomFieldValue): boolean {
  return !!value.nodeId.trim() && Number.isInteger(value.depth) && value.depth >= 1 && value.depth <= 5
    && (value.limit == null || (Number.isInteger(value.limit) && value.limit > 0))
    && (value.mode === undefined || ["full", "index", "titles"].includes(value.mode));
}
