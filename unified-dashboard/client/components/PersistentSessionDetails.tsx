import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Button, type ModelPresetAvailability } from "@seosoyoung/soul-ui";

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
import { SettingsAlert, SettingsGroupBox } from "./config/SettingsListDetail";

export type PersistentSessionDetailsSection = "all" | "account" | "display" | "record";

export type PersistentSessionDetailsDraft = {
  displayName: string;
  modelPreset: string;
  showCharacter: boolean;
  animateCharacter: boolean;
  showGenerationSeparator: boolean;
  showJevCandidates: boolean;
  showTurnUsage: boolean;
};

export type PersistentSessionDetailsField = keyof PersistentSessionDetailsDraft;
type DisplayField = Exclude<PersistentSessionDetailsField, "displayName" | "modelPreset">;

const DISPLAY_SETTING: Record<DisplayField, keyof PersistentSession["settings"]> = {
  showCharacter: "show_character",
  animateCharacter: "animate_character",
  showGenerationSeparator: "show_generation_separator",
  showJevCandidates: "show_jev_candidates",
  showTurnUsage: "show_turn_usage",
};

const PARTIAL_SAVE_NOTE = "일부 변경이 저장됐을 수 있습니다. 다시 읽거나 저장해 주세요.";

export function persistentSessionDetailsDraft(session: PersistentSession): PersistentSessionDetailsDraft {
  return {
    displayName: session.display_name ?? "",
    modelPreset: session.settings.default_model.model_preset ?? "",
    showCharacter: session.settings.show_character,
    animateCharacter: session.settings.animate_character,
    showGenerationSeparator: session.settings.show_generation_separator,
    showJevCandidates: session.settings.show_jev_candidates,
    showTurnUsage: session.settings.show_turn_usage,
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
  const [draftState, setDraftState] = useState(() => ({
    sessionId: resource?.session_id ?? null,
    draft: resource ? persistentSessionDetailsDraft(resource) : emptyDetailsDraft(),
  }));
  const draft = resource && draftState.sessionId !== resource.session_id
    ? persistentSessionDetailsDraft(resource)
    : draftState.draft;
  const [pending, setPending] = useState(false);
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

  const failureText = (caught: unknown) => {
    const text = errorMessage(caught);
    return caught instanceof HttpResponseError && caught.status < 500
      ? text
      : `${text} ${PARTIAL_SAVE_NOTE}`;
  };

  const saveDisplayField = useCallback(async (field: DisplayField, value: boolean) => {
    if (!resource || !resource.node_id || pending) return;
    setPending(true);
    setError(null);
    setErrorScope(null);
    try {
      const key = DISPLAY_SETTING[field];
      const { session } = await api.update(resource.session_id, { settings: { [key]: value } });
      onSaved(session);
    } catch (caught) {
      setError("저장하지 못했습니다. 다시 눌러 주세요.");
      setErrorScope("display");
      if (caught instanceof PersistentSessionError && caught.code === "NOT_PERSISTENT") onNotPersistent?.();
    } finally {
      setPending(false);
    }
  }, [api, onNotPersistent, onSaved, pending, resource]);

  const onFieldChange = useCallback(<K extends PersistentSessionDetailsField>(
    field: K,
    value: PersistentSessionDetailsDraft[K],
    options: { saveImmediately?: boolean } = {},
  ) => {
    if (options.saveImmediately && field in DISPLAY_SETTING) {
      void saveDisplayField(field as DisplayField, value as boolean);
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
      setError("세션 이름을 입력하세요.");
      setErrorScope("account");
      return;
    }
    if (!draft.modelPreset) {
      setError("기본 모델을 선택하세요.");
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
  }, [acceptSaved, api, draft, onNotPersistent, pending, resource]);

  return { draft, pending, error, errorScope, onFieldChange, save, resetDraft };
}

export function PersistentSessionDetails({
  resource,
  draft,
  pending,
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
  const nodeUnknown = !resource.node_id;
  const showsAccount = section === "all" || section === "account";
  const showsDisplay = section === "all" || section === "display";
  const showsRecord = section === "record";
  const modelNodeId = resource.node_id ?? "";
  const currentModel = currentModelText(resource);
  const pendingValue = pendingText(resource);
  const visibleError = error && (section === "all" || !errorScope || section === errorScope) ? error : null;
  const resaveNeeded = (() => {
    const saved = resource.settings.default_model;
    const next = resource.runtime.pending;
    return !sameModel(saved, resource.runtime.current_model)
      && !(next && sameModel({ model_preset: next.target_model_preset, reasoning_effort: next.target_reasoning_effort }, saved));
  })();

  if (showsRecord) return <div className="space-y-4">{monitoring}</div>;

  const nameField = <SettingFieldWidget
    field={textField("display_name", "세션 이름", draft.displayName, nodeUnknown)}
    value={draft.displayName}
    onChange={(value) => onFieldChange("displayName", value)}
  />;
  const modelSelect = <NodeModelPresetSelect
    className="v3-model-preset-field"
    triggerClassName="v3-model-preset-trigger"
    nodeId={modelNodeId}
    value={draft.modelPreset}
    label="기본 모델"
    disabled={pending || nodeUnknown}
    modelPresetCatalog={modelPresetCatalog}
    onValueChange={(value) => onFieldChange("modelPreset", value)}
    onError={onModelError}
  />;

  return <div className="space-y-4">
    {visibleError ? <SettingsAlert scrollIntoView>{visibleError}</SettingsAlert> : null}
    {nodeUnknown ? <SettingsAlert>이 세션의 노드를 알 수 없어 편집할 수 없습니다.</SettingsAlert> : null}
    {showsAccount ? <>
      <div>
        {nameField}
        <SettingFieldWidget field={textField("agent", "에이전트", agentLabel(resource), true, "만든 뒤에는 바꿀 수 없습니다.")} value={agentLabel(resource)} onChange={() => undefined} />
        <SettingFieldWidget field={{ ...textField("current_model", "현재 실행 모델", currentModel, true), read_only_display: section === "account" }} value={currentModel} onChange={() => undefined} />
        <SettingFieldWidget field={{ ...textField("pending", "대기 중인 변경", pendingValue, true, resaveNeeded ? "기본 모델 변경 요청이 없습니다. 다시 저장해 주세요." : ""), read_only_display: section === "account" }} value={pendingValue} onChange={() => undefined} />
      </div>
      <PersistentSessionAvailability resource={resource} presets={weeklyAvailability} />
    </> : null}
    {showsDisplay ? <div>
      <DisplayToggle field="showCharacter" label="캐릭터 표시" value={draft.showCharacter} resourceValue={resource.settings.show_character} pending={pending} immediate={immediateDisplaySave} disabled={nodeUnknown} onChange={onFieldChange} />
      <DisplayToggle field="animateCharacter" label="캐릭터 움직임" value={draft.animateCharacter} resourceValue={resource.settings.animate_character} pending={pending} immediate={immediateDisplaySave} disabled={nodeUnknown} onChange={onFieldChange} />
      <DisplayToggle field="showGenerationSeparator" label="세대 구분선 표시" description="세대가 바뀐 자리에 구분선을 보여 줍니다. 끄면 화면에서만 숨기고 기록은 남습니다." value={draft.showGenerationSeparator} resourceValue={resource.settings.show_generation_separator} pending={pending} immediate={immediateDisplaySave} disabled={nodeUnknown} onChange={onFieldChange} />
      <DisplayToggle field="showJevCandidates" label="Jev 후보 표시" description="내 입력 아래에 Jev가 찾은 후보를 접힌 줄로 보여 줍니다. 끄면 화면에서만 숨기고 기록은 남습니다." value={draft.showJevCandidates} resourceValue={resource.settings.show_jev_candidates} pending={pending} immediate={immediateDisplaySave} disabled={nodeUnknown} onChange={onFieldChange} />
      <DisplayToggle field="showTurnUsage" label="턴 끝 사용량 표시" value={draft.showTurnUsage} resourceValue={resource.settings.show_turn_usage} pending={pending} immediate={immediateDisplaySave} disabled={nodeUnknown} onChange={onFieldChange} />
    </div> : null}
    {showsAccount ? <>
      <SettingsGroupBox title="실행 대상"><div className="v3-succession-assignment">{modelSelect}</div></SettingsGroupBox>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={pending || nodeUnknown} onClick={onSave}>{pending ? "저장 중..." : "변경 저장"}</Button>
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
  immediate: boolean;
  disabled: boolean;
  onChange<K extends PersistentSessionDetailsField>(field: K, value: PersistentSessionDetailsDraft[K], options?: { saveImmediately?: boolean }): void;
}) {
  const displayValue = immediate ? resourceValue : value;
  return <SettingFieldWidget
    field={{ ...boolField(field, label, displayValue, description), read_only: disabled || (!immediate && pending) }}
    value={String(displayValue)}
    interactionBlocked={immediate && pending}
    saving={immediate && pending}
    onChange={(next) => onChange(field, next === "true", { saveImmediately: immediate })}
  />;
}

function textField(key: string, label: string, value: string, readOnly: boolean, description = ""): SettingField {
  return { key, field_name: key, label, description, value, value_type: "str", sensitive: false, hot_reloadable: true, read_only: readOnly };
}

function boolField(key: string, label: string, value: boolean, description = ""): SettingField {
  return { key, field_name: key, label, description, value, value_type: "bool", sensitive: false, hot_reloadable: true, read_only: false };
}

function agentLabel(session: PersistentSession): string {
  return session.agent_name ?? session.agent_id ?? "에이전트 정보 없음";
}

function currentModelText(session: PersistentSession): string {
  const { model_preset, model, reasoning_effort } = session.runtime.current_model;
  const parts = [model ?? model_preset, reasoning_effort].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : "모델 정보 없음";
}

function pendingText(session: PersistentSession): string {
  const pending = session.runtime.pending;
  if (!pending) return "대기 변경 없음";
  return `다음 실행부터 ${pending.target_model_preset}${pending.target_reasoning_effort ? ` · ${pending.target_reasoning_effort}` : ""}`;
}

function sameModel(a: ModelSelection, b: ModelSelection) {
  return a.model_preset === b.model_preset && (a.reasoning_effort ?? null) === (b.reasoning_effort ?? null);
}

function errorMessage(value: unknown) { return value instanceof Error ? value.message : String(value); }

function emptyDetailsDraft(): PersistentSessionDetailsDraft {
  return { displayName: "", modelPreset: "", showCharacter: true, animateCharacter: true, showGenerationSeparator: true, showJevCandidates: true, showTurnUsage: true };
}
