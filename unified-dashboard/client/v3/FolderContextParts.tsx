import { useTranslation } from "react-i18next";
import { useEffect, useId, useState } from "react";
import { Folder, X } from "lucide-react";
import { AtomNodeSelector, Button, Switch, type AgentInfo } from "@seosoyoung/soul-ui";

import type { AssignmentData } from "./AgentNodeAssignmentFields";
import type { ContextSource, ProjectFormAtomReference } from "./project-form-model";
import { useNodeModelPresetCatalog } from "../lib/use-node-model-preset-catalog";
import "./v3-folder-settings.css";

export interface ReferenceDraft {
  instance: "atom" | "atom-nl";
  nodeId: string;
  nodeTitle: string;
  depth: number;
  titlesOnly: boolean;
  limit?: number | null;
  mode?: "full" | "index" | "titles";
}

export const NEW_REFERENCE: ReferenceDraft = { instance: "atom", nodeId: "", nodeTitle: "", depth: 3, titlesOnly: false };
const DEPTHS = [1, 2, 3, 4, 5] as const;

export function ContextSourceToggle({ label, value, disabled, onChange }: {
  label: string; value: ContextSource; disabled?: boolean; onChange(value: ContextSource): void;
}) {
  const { t } = useTranslation();
  return <div className="v3-completed-periods v3-context-source-toggle" role="group" aria-label={t("folders.settings.sourceGroup", { name: label })}>
    {(["inherit", "own"] as const).map((source) => <Button key={source} type="button" size="sm" variant="ghost" disabled={disabled}
      aria-pressed={value === source} onClick={() => onChange(source)}>
      {source === "inherit" ? t("folders.settings.inherit") : t("folders.settings.own")}
    </Button>)}
  </div>;
}

export function ContextSourceMark({ name }: { name: string }) {
  return <span className="v3-context-source-mark"><Folder aria-hidden="true" />{name}</span>;
}

export function referenceMeta(reference: Pick<ReferenceDraft, "depth" | "titlesOnly">, t: ReturnType<typeof useTranslation>["t"]): string {
  const depth = t("folders.settings.referenceDepth", { depth: reference.depth });
  return reference.titlesOnly ? `${depth} · ${t("folders.settings.referenceTitlesOnly")}` : depth;
}

export interface InheritedReferenceRow {
  key: string;
  nodeTitle: string;
  depth: number | null;
  titlesOnly: boolean | null;
  sourceName: string;
}

export function ReferenceRows({ inherited = [], own, disabled, onEdit, onRemove }: {
  inherited?: readonly InheritedReferenceRow[];
  own: readonly Pick<ProjectFormAtomReference, "nodeTitle" | "depth" | "titlesOnly" | "blockId" | "draftId" | "nodeId">[];
  disabled?: boolean;
  onEdit(index: number, trigger: HTMLElement): void;
  onRemove(index: number): void;
}) {
  const { t } = useTranslation();
  if (inherited.length + own.length === 0) return null;
  return <ul className="v3-reference-rows">
    {inherited.map((row) => <li key={row.key} data-inherited="true">
      <span className="v3-reference-main">
        <span>{row.nodeTitle}</span>
        <small>{referenceMeta({ depth: row.depth ?? 3, titlesOnly: row.titlesOnly ?? false }, t)}</small>
      </span>
      <ContextSourceMark name={row.sourceName} />
    </li>)}
    {own.map((row, index) => <li key={row.blockId ?? row.draftId ?? row.nodeId}>
      <button type="button" className="v3-reference-main" disabled={disabled}
        aria-label={t("folders.settings.editNamed", { name: row.nodeTitle })}
        onClick={(event) => onEdit(index, event.currentTarget)}>
        <span>{row.nodeTitle}</span>
        <small>{referenceMeta(row, t)}</small>
      </button>
      <Button type="button" size="icon-sm" variant="ghost" disabled={disabled}
        aria-label={t("folders.settings.removeNamed", { name: row.nodeTitle })} onClick={() => onRemove(index)}>
        <X aria-hidden="true" />
      </Button>
    </li>)}
  </ul>;
}

export function ReferencePicker({ value, request, disabled, selectorOpen, onSelectorOpenChange, onSelectorStatusChange, onChange }: {
  value: ReferenceDraft;
  request?: typeof fetch;
  disabled?: boolean;
  selectorOpen: boolean;
  onSelectorOpenChange(open: boolean): void;
  onSelectorStatusChange?(status: "loading" | "ready" | "error"): void;
  onChange(value: ReferenceDraft): void;
}) {
  const { t } = useTranslation();
  const nodeLabel = useId();
  const depthLabel = useId();
  return <div className="v3-succession-context-editor v3-reference-picker">
    <section role="group" aria-labelledby={nodeLabel}>
      <strong id={nodeLabel}>{t("folders.settings.node")}</strong>
      <AtomNodeSelector presentation="inline" request={request} value={value.nodeId} selectedTitle={value.nodeTitle}
        disabled={disabled || value.instance !== "atom"} open={selectorOpen} onOpenChange={onSelectorOpenChange}
        onStatusChange={onSelectorStatusChange}
        onChange={(nodeId, nodeTitle) => onChange({ ...value, nodeId, nodeTitle })} />
    </section>
    <section>
      <div className="v3-picker-row">
        <strong id={depthLabel}>{t("folders.settings.depth")}</strong>
        <div className="v3-completed-periods" role="group" aria-labelledby={depthLabel}>
          {DEPTHS.map((depth) => <Button key={depth} type="button" size="sm" variant="ghost" disabled={disabled}
            aria-pressed={value.depth === depth} onClick={() => onChange({ ...value, depth })}>{depth}</Button>)}
        </div>
      </div>
      <label className="v3-picker-row">
        <strong>{t("folders.settings.titlesOnly")}</strong>
        <Switch checked={value.titlesOnly} disabled={disabled} onCheckedChange={(titlesOnly) => onChange({ ...value, titlesOnly })} />
      </label>
    </section>
  </div>;
}

/** The folder's default environment as people read it: agent name, node, model label. */
export function useExecutionEnvironmentLabel(
  defaults: { agentId: string | null; nodeId: string | null; modelPreset: string | null } | null,
  assignment?: AssignmentData,
): string {
  const nodeId = defaults?.nodeId ?? "";
  const suppliedCatalog = assignment?.modelPresetCatalog.nodeId === nodeId ? assignment.modelPresetCatalog : null;
  const fetchedCatalog = useNodeModelPresetCatalog(suppliedCatalog || !defaults?.modelPreset ? "" : nodeId);
  const catalog = suppliedCatalog ?? fetchedCatalog;
  const [agents, setAgents] = useState<readonly AgentInfo[]>(assignment?.agents ?? []);
  useEffect(() => {
    if (assignment) { setAgents(assignment.agents); return; }
    if (!nodeId || !defaults?.agentId) { setAgents([]); return; }
    let active = true;
    void fetch(`/api/nodes/${encodeURIComponent(nodeId)}/agents`, { credentials: "same-origin", headers: { Accept: "application/json" } })
      .then(async (response) => response.ok ? (await response.json() as { agents?: AgentInfo[] }).agents ?? [] : [])
      .catch(() => [] as AgentInfo[])
      .then((next) => { if (active) setAgents(next); });
    return () => { active = false; };
  }, [assignment, defaults?.agentId, nodeId]);
  if (!defaults) return "";
  const agentName = agents.find((agent) => agent.id === defaults.agentId)?.name ?? defaults.agentId;
  const modelLabel = catalog.presets.find((preset) => preset.id === defaults.modelPreset)?.label ?? defaults.modelPreset;
  return [agentName, defaults.nodeId, modelLabel].filter(Boolean).join(" · ");
}
