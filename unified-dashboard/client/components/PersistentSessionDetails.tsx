import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { PersistentTurnUsageMode } from "../../../packages/wire-schema/src/persistent_session_settings";
import { Button } from "@seosoyoung/soul-ui";
import type { ModelPresetAvailability } from "@seosoyoung/soul-ui/lib/model-preset-availability";

import { HttpResponseError } from "../lib/http-response-error";
import {
  type ModelSelection,
  PersistentSessionError,
  type PersistentSession,
  type PersistentSessionsApi,
} from "../lib/persistent-sessions";
import type { NodeModelPresetCatalog } from "../lib/use-node-model-preset-catalog";
import { NodeModelPresetSelect } from "./NodeModelPresetSelect";
import { PersistentSessionAvailability } from "./PersistentSessionMonitoring";
import { SettingFieldWidget, type SettingField } from "./config/SettingFieldWidget";
import { agentLabel, currentModelText, textField } from "./persistent-session-fields";
import { SettingsAlert, SettingsGroupBox } from "./config/SettingsListDetail";

export type PersistentSessionDetailsSection = "all" | "instructions" | "account" | "display" | "record";

export type PersistentSessionDetailsDraft = {
  displayName: string;
  modelPreset: string;
  showCharacter: boolean;
  animateCharacter: boolean;
  showGenerationSeparator: boolean;
  showJevCandidates: boolean;
  showWorkDetails: boolean;
  turnUsageMode: PersistentTurnUsageMode;
};

export type PersistentSessionDetailsField = keyof PersistentSessionDetailsDraft;
type DisplayField = Exclude<PersistentSessionDetailsField, "displayName" | "modelPreset" | "turnUsageMode">;
type ImmediateDisplayField = DisplayField | "turnUsageMode";

const DISPLAY_SETTING: Record<DisplayField, keyof PersistentSession["settings"]> = {
  showCharacter: "show_character",
  animateCharacter: "animate_character",
  showGenerationSeparator: "show_generation_separator",
  showJevCandidates: "show_jev_candidates",
  showWorkDetails: "show_work_details",
};

type Translate = ReturnType<typeof useTranslation>["t"];

export function persistentSessionDetailsDraft(session: PersistentSession): PersistentSessionDetailsDraft {
  return {
    displayName: session.display_name ?? "",
    modelPreset: session.settings.default_model.model_preset ?? "",
    showCharacter: session.settings.show_character,
    animateCharacter: session.settings.animate_character,
    showGenerationSeparator: session.settings.show_generation_separator,
    showJevCandidates: session.settings.show_jev_candidates,
    showWorkDetails: session.settings.show_work_details === true,
    turnUsageMode: session.settings.turn_usage_mode,
  };
}

export function usePersistentSessionDetailsController({
  resource,
  api,
  onSaved,
  onNotPersistent,
}: {
  resource: PersistentSession | null;
  api: PersistentSessionsApi;
  onSaved(session: PersistentSession): void;
  onNotPersistent?(): void;
}) {
  const { t } = useTranslation();
  const [draftState, setDraftState] = useState(() => ({
    sessionId: resource?.session_id ?? null,
    draft: resource ? persistentSessionDetailsDraft(resource) : emptyDetailsDraft(),
  }));
  const draft = resource && draftState.sessionId !== resource.session_id
    ? persistentSessionDetailsDraft(resource)
    : draftState.draft;
  const [pending, setPending] = useState(false);
  const [savingDisplayField, setSavingDisplayField] = useState<ImmediateDisplayField | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorScope, setErrorScope] = useState<"account" | "display" | null>(null);

  useEffect(() => {
    setDraftState({ sessionId: resource?.session_id ?? null, draft: resource ? persistentSessionDetailsDraft(resource) : emptyDetailsDraft() });
    setError(null);
    setErrorScope(null);
  }, [resource?.session_id]);

  const acceptSaved = useCallback((session: PersistentSession) => {
    setDraftState({ sessionId: session.session_id, draft: persistentSessionDetailsDraft(session) });
    onSaved(session);
    setErrorScope(null);
  }, [onSaved]);

  const resetDraft = useCallback(() => {
    setDraftState({ sessionId: resource?.session_id ?? null, draft: resource ? persistentSessionDetailsDraft(resource) : emptyDetailsDraft() });
    setError(null);
    setErrorScope(null);
  }, [resource]);

  const failureText = useCallback((caught: unknown) => {
    const text = errorMessage(caught);
    return caught instanceof HttpResponseError && caught.status < 500
      ? text
      : `${text} ${t("jobs.persistent.partialSave")}`;
  }, [t]);

  const saveDisplayField = useCallback(async (field: ImmediateDisplayField, value: boolean | PersistentTurnUsageMode) => {
    if (!resource || !resource.node_id || pending) return;
    setPending(true);
    setSavingDisplayField(field);
    setError(null);
    setErrorScope(null);
    try {
      const key = field === "turnUsageMode" ? "turn_usage_mode" : DISPLAY_SETTING[field];
      const { session } = await api.update(resource.session_id, { settings: { [key]: value } });
      setDraftState((current) => {
        const next = persistentSessionDetailsDraft(session);
        const previous = current.sessionId === session.session_id ? current.draft : next;
        return { sessionId: session.session_id, draft: { ...next, displayName: previous.displayName, modelPreset: previous.modelPreset } };
      });
      onSaved(session);
    } catch (caught) {
      setError(t("jobs.persistent.saveError"));
      setErrorScope("display");
      if (caught instanceof PersistentSessionError && caught.code === "NOT_PERSISTENT") onNotPersistent?.();
    } finally {
      setSavingDisplayField(null);
      setPending(false);
    }
  }, [api, onNotPersistent, onSaved, pending, resource, t]);

  const onFieldChange = useCallback(<K extends PersistentSessionDetailsField>(
    field: K,
    value: PersistentSessionDetailsDraft[K],
    options: { saveImmediately?: boolean } = {},
  ) => {
    if (options.saveImmediately && (field in DISPLAY_SETTING || field === "turnUsageMode")) {
      void saveDisplayField(field as ImmediateDisplayField, value as boolean | PersistentTurnUsageMode);
      return;
    }
    setDraftState((current) => {
      const base = current.sessionId === resource?.session_id ? current.draft : resource ? persistentSessionDetailsDraft(resource) : emptyDetailsDraft();
      return { sessionId: resource?.session_id ?? null, draft: { ...base, [field]: value } };
    });
    setError(null);
    setErrorScope(null);
  }, [resource, saveDisplayField]);

  const save = useCallback(async () => {
    if (!resource || !resource.node_id || pending) return;
    const displayName = draft.displayName.trim();
    if (!displayName) {
      setError(t("jobs.persistent.missingName"));
      setErrorScope("account");
      return;
    }
    if (!draft.modelPreset) {
      setError(t("jobs.persistent.missingDefaultModel"));
      setErrorScope("account");
      return;
    }
    const savedModel = resource.settings.default_model;
    const defaultModel: ModelSelection = {
      model_preset: draft.modelPreset,
      reasoning_effort: savedModel.model_preset === draft.modelPreset ? savedModel.reasoning_effort : null,
    };
    const settings: Record<string, unknown> = { default_model: defaultModel };
    for (const [field, key] of Object.entries(DISPLAY_SETTING) as Array<[DisplayField, string]>) {
      if (draft[field] !== resource.settings[key as keyof PersistentSession["settings"]]) {
        settings[key] = draft[field];
      }
    }
    if (draft.turnUsageMode !== resource.settings.turn_usage_mode) settings.turn_usage_mode = draft.turnUsageMode;
    setPending(true);
    setError(null);
    setErrorScope(null);
    try {
      const { session } = await api.update(resource.session_id, {
        display_name: displayName,
        settings: settings as Parameters<PersistentSessionsApi["update"]>[1]["settings"],
      });
      acceptSaved(session);
    } catch (caught) {
      setError(failureText(caught));
      setErrorScope("account");
      if (caught instanceof PersistentSessionError && caught.code === "NOT_PERSISTENT") onNotPersistent?.();
    } finally {
      setPending(false);
    }
  }, [acceptSaved, api, draft, failureText, onNotPersistent, pending, resource, t]);

  return { draft, pending, savingDisplayField, error, errorScope, onFieldChange, save, resetDraft };
}

export function PersistentSessionDetails({
  resource,
  draft,
  pending,
  savingDisplayField = null,
  error,
  errorScope,
  section = "all",
  immediateDisplaySave = false,
  modelPresetCatalog,
  weeklyAvailability = [],
  monitoring,
  onFieldChange,
  onSave,
  onModelError,
}: {
  resource: PersistentSession;
  draft: PersistentSessionDetailsDraft;
  pending: boolean;
  savingDisplayField?: ImmediateDisplayField | null;
  error: string | null;
  errorScope?: "account" | "display" | null;
  section?: PersistentSessionDetailsSection;
  immediateDisplaySave?: boolean;
  modelPresetCatalog?: NodeModelPresetCatalog;
  weeklyAvailability?: readonly ModelPresetAvailability[];
  monitoring?: ReactNode;
  onFieldChange<K extends PersistentSessionDetailsField>(field: K, value: PersistentSessionDetailsDraft[K], options?: { saveImmediately?: boolean }): void;
  onSave(): void;
  onModelError?(message: string): void;
}) {
  const { t } = useTranslation();
  const nodeUnknown = !resource.node_id;
  const showsAccount = section === "all" || section === "account";
  const showsDisplay = section === "all" || section === "display";
  const showsRecord = section === "record";
  const modelNodeId = resource.node_id ?? "";
  const currentModel = currentModelText(resource, t);
  const pendingValue = pendingText(resource, t);
  const visibleError = error && (section === "all" || !errorScope || section === errorScope) ? error : null;
  const resaveNeeded = (() => {
    const saved = resource.settings.default_model;
    const next = resource.runtime.pending;
    return !sameModel(saved, resource.runtime.current_model)
      && !(next && sameModel({ model_preset: next.target_model_preset, reasoning_effort: next.target_reasoning_effort }, saved));
  })();

  if (showsRecord) return <div className="space-y-4">{monitoring}</div>;

  const nameField = <SettingFieldWidget
    field={textField("display_name", t("jobs.persistent.name"), draft.displayName, nodeUnknown)}
    value={draft.displayName}
    onChange={(value) => onFieldChange("displayName", value)}
  />;
  const modelSelect = <NodeModelPresetSelect
    className="v3-model-preset-field"
    triggerClassName="v3-model-preset-trigger"
    nodeId={modelNodeId}
    value={draft.modelPreset}
    label={t("jobs.common.defaultModel")}
    disabled={pending || nodeUnknown}
    modelPresetCatalog={modelPresetCatalog}
    onValueChange={(value) => onFieldChange("modelPreset", value)}
    onError={onModelError}
  />;

  return <div className="space-y-4">
    {visibleError ? <SettingsAlert scrollIntoView><span data-v3-selectable-content="true">{visibleError}</span></SettingsAlert> : null}
    {nodeUnknown ? <SettingsAlert><span data-v3-selectable-content="true">{t("jobs.persistent.unknownNode")}</span></SettingsAlert> : null}
    <div>
      {showsAccount ? <>
        {nameField}
        <SettingFieldWidget
          field={{
            ...textField("agent", t("jobs.persistent.agent"), agentLabel(resource, t), true, section === "account" ? "" : t("jobs.persistent.agentFixed")),
            read_only_display: section === "account",
          }}
          value={agentLabel(resource, t)}
          onChange={() => undefined}
        />
        <SettingFieldWidget field={{ ...textField("current_model", t("jobs.persistent.currentModel"), currentModel, true), read_only_display: section === "account" }} value={currentModel} onChange={() => undefined} />
        <SettingFieldWidget field={{ ...textField("pending", t("jobs.persistent.pendingChange"), pendingValue, true, resaveNeeded ? t("jobs.persistent.resaveModel") : ""), read_only_display: section === "account" }} value={pendingValue} onChange={() => undefined} />
      </> : null}
      {showsDisplay ? <>
        <DisplayToggle field="showCharacter" label={t("jobs.persistent.showCharacter")} value={draft.showCharacter} resourceValue={resource.settings.show_character} pending={pending} saving={pending && savingDisplayField === "showCharacter"} immediate={immediateDisplaySave} disabled={nodeUnknown} onChange={onFieldChange} />
        <DisplayToggle field="animateCharacter" label={t("jobs.persistent.animateCharacter")} value={draft.animateCharacter} resourceValue={resource.settings.animate_character} pending={pending} saving={pending && savingDisplayField === "animateCharacter"} immediate={immediateDisplaySave} disabled={nodeUnknown} onChange={onFieldChange} />
        <DisplayToggle field="showGenerationSeparator" label={t("jobs.persistent.showGenerationSeparator")} value={draft.showGenerationSeparator} resourceValue={resource.settings.show_generation_separator} pending={pending} saving={pending && savingDisplayField === "showGenerationSeparator"} immediate={immediateDisplaySave} disabled={nodeUnknown} onChange={onFieldChange} />
        <DisplayToggle field="showJevCandidates" label={t("jobs.persistent.showJevCandidates")} value={draft.showJevCandidates} resourceValue={resource.settings.show_jev_candidates} pending={pending} saving={pending && savingDisplayField === "showJevCandidates"} immediate={immediateDisplaySave} disabled={nodeUnknown} onChange={onFieldChange} />
        <DisplayToggle field="showWorkDetails" label={t("jobs.persistent.showWorkDetails")} description={t("jobs.persistent.workDetailsHelp")} value={draft.showWorkDetails} resourceValue={resource.settings.show_work_details === true} pending={pending} saving={pending && savingDisplayField === "showWorkDetails"} immediate={immediateDisplaySave} disabled={nodeUnknown} onChange={onFieldChange} />
        <TurnUsageModeField value={draft.turnUsageMode} resourceValue={resource.settings.turn_usage_mode} pending={pending} saving={pending && savingDisplayField === "turnUsageMode"} immediate={immediateDisplaySave} disabled={nodeUnknown} onChange={onFieldChange} />
      </> : null}
    </div>
    {showsAccount ? <PersistentSessionAvailability resource={resource} presets={weeklyAvailability} /> : null}
    {showsAccount ? <>
      <SettingsGroupBox title={t("jobs.common.executionTarget")}><div className="v3-succession-assignment">{modelSelect}</div></SettingsGroupBox>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={pending || nodeUnknown} onClick={onSave}>{pending ? t("jobs.common.savingLegacy") : t("jobs.common.saveChanges")}</Button>
      </div>
    </> : null}
  </div>;
}

function DisplayToggle({
  field,
  label,
  description = "",
  value,
  resourceValue,
  pending,
  saving,
  immediate,
  disabled,
  onChange,
}: {
  field: DisplayField;
  label: string;
  description?: string;
  value: boolean;
  resourceValue: boolean;
  pending: boolean;
  saving: boolean;
  immediate: boolean;
  disabled: boolean;
  onChange<K extends PersistentSessionDetailsField>(field: K, value: PersistentSessionDetailsDraft[K], options?: { saveImmediately?: boolean }): void;
}) {
  const displayValue = immediate ? resourceValue : value;
  return <SettingFieldWidget
    field={{ ...boolField(field, label, displayValue, description), read_only: disabled || (!immediate && pending) }}
    value={String(displayValue)}
    interactionBlocked={immediate && pending}
    saving={immediate ? saving : undefined}
    onChange={(next) => onChange(field, next === "true", { saveImmediately: immediate })}
  />;
}

function TurnUsageModeField({ value, resourceValue, pending, saving, immediate, disabled, onChange }: {
  value: PersistentTurnUsageMode;
  resourceValue: PersistentTurnUsageMode;
  pending: boolean;
  saving: boolean;
  immediate: boolean;
  disabled: boolean;
  onChange<K extends PersistentSessionDetailsField>(field: K, value: PersistentSessionDetailsDraft[K], options?: { saveImmediately?: boolean }): void;
}) {
  const { t } = useTranslation();
  const selectedMode = immediate ? resourceValue : value;
  const modes: Array<{ value: PersistentTurnUsageMode; label: string }> = [
    { value: "collapsed", label: t("jobs.persistent.collapsed") },
    { value: "expanded", label: t("jobs.persistent.expanded") },
    { value: "hidden", label: t("jobs.persistent.hidden") },
  ];
  return <SettingFieldWidget
    field={textField("turn_usage_mode", t("jobs.persistent.turnUsage"), selectedMode, disabled)}
    value={selectedMode}
    onChange={() => undefined}
    controlSlot={<div className="flex min-w-0 flex-wrap items-center gap-2" role="group" aria-label={t("jobs.persistent.turnUsage")}>
      {modes.map((mode) => <Button
        key={mode.value}
        type="button"
        size="sm"
        variant={selectedMode === mode.value ? "default" : "outline"}
        aria-pressed={selectedMode === mode.value}
        disabled={disabled || pending}
        onClick={() => onChange("turnUsageMode", mode.value, { saveImmediately: immediate })}
      >{mode.label}</Button>)}
    </div>}
    statusSlot={saving ? <span role="status" className="text-xs text-muted-foreground">{t("jobs.common.saving")}</span> : undefined}
  />;
}

function boolField(key: string, label: string, value: boolean, description = ""): SettingField {
  return { key, field_name: key, label, description, value, value_type: "bool", sensitive: false, hot_reloadable: true, read_only: false };
}

function pendingText(session: PersistentSession, t: Translate): string {
  const pending = session.runtime.pending;
  if (!pending) return t("jobs.persistent.noPendingChange");
  return t("jobs.persistent.pendingModel", { model: pending.target_model_preset, effort: pending.target_reasoning_effort ? ` · ${pending.target_reasoning_effort}` : "" });
}

function sameModel(a: ModelSelection, b: ModelSelection) {
  return a.model_preset === b.model_preset && (a.reasoning_effort ?? null) === (b.reasoning_effort ?? null);
}

function errorMessage(value: unknown) { return value instanceof Error ? value.message : String(value); }

function emptyDetailsDraft(): PersistentSessionDetailsDraft {
  return { displayName: "", modelPreset: "", showCharacter: true, animateCharacter: true, showGenerationSeparator: true, showJevCandidates: true, showWorkDetails: false, turnUsageMode: "collapsed" };
}
