import { useTranslation } from "react-i18next";
import { useEffect, useState } from "react";
import { Button, FrameLoading } from "@seosoyoung/soul-ui";
import { CardApiError, cardRequest } from "@seosoyoung/soul-ui/cards/card-api";
import { fetchNodeModelPresets } from "@seosoyoung/soul-ui/shared/model-presets";
import { PERSISTENT_FALLBACK_MODELS_MAX, type PersistentModelSelection } from "../../../packages/wire-schema/src/persistent_session_settings";
import { createPersistentSessionsApi } from "../lib/persistent-sessions";
import type { NodeModelPresetCatalog } from "../lib/use-node-model-preset-catalog";
import { CatalogSelectionField } from "./CatalogSelectionField";
import { NodeModelPresetSelect } from "./NodeModelPresetSelect";

export type PersistentDefaultsValue = {
  model_preset: string;
  fallback_models: Array<Pick<PersistentModelSelection, "model_preset" | "reasoning_effort">>;
};
export type PersistentDefaultsPayload = { value: PersistentDefaultsValue; version: number; source: "catalog" | "settings" };
type Translate = ReturnType<typeof useTranslation>["t"];

export interface PersistentDefaultsSettingsService {
  read(t: Translate): Promise<PersistentDefaultsPayload>;
  write(input: { value: PersistentDefaultsValue; expectedVersion: number }, t: Translate): Promise<PersistentDefaultsPayload>;
  presets(t: Translate): Promise<NodeModelPresetCatalog>;
}
const endpoint = "/api/admin/settings/persistent-defaults";
/** 설정 화면이 모델 목록을 읽는 기본 실행 노드의 프리셋. 영구 세션 기본 모델과 요약 설정이 함께 쓴다. */
export async function loadDefaultNodeModelPresets(t: Translate): Promise<NodeModelPresetCatalog> {
  const { create_defaults } = await createPersistentSessionsApi(fetch, t).list();
  const nodeId = create_defaults?.node_id;
  if (!nodeId) throw new Error(t("jobs.defaults.missingDefaultNode"));
  const presets = await fetchNodeModelPresets(nodeId);
  return { nodeId, presets, status: "ready" };
}
const defaultService: PersistentDefaultsSettingsService = {
  read: async (t) => {
    try { return await cardRequest(endpoint, "GET", undefined, undefined, t); }
    catch (error) {
      if (error instanceof CardApiError && !error.hasServerMessage) {
        throw new Error(t("jobs.defaults.loadError", { status: error.status }));
      }
      throw error;
    }
  },
  write: (input, t) => cardRequest(endpoint, "PUT", input, undefined, t),
  presets: loadDefaultNodeModelPresets,
};
const missingLabel = (id: string) => id;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function PersistentDefaultsSettingsForm({ service = defaultService }: { service?: PersistentDefaultsSettingsService } = {}) {
  const { t } = useTranslation();
  const [payload, setPayload] = useState<PersistentDefaultsPayload | null>(null);
  const [draft, setDraft] = useState<PersistentDefaultsValue | null>(null);
  const [catalog, setCatalog] = useState<NodeModelPresetCatalog | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true); setLoadError(null); setError(null); setMessage(null);
    try {
      const [next, available] = await Promise.all([service.read(t), service.presets(t)]);
      setPayload(next); setDraft(next.value); setCatalog(available); setConflict(false);
    } catch (caught) {
      setCatalog(null); setLoadError(errorText(caught));
    } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [service, t]);
  const changed = Boolean(draft && payload && JSON.stringify(draft) !== JSON.stringify(payload.value));
  const ready = catalog?.status === "ready";
  function updateFallback(index: number, patch: Partial<PersistentDefaultsValue["fallback_models"][number]>) {
    setMessage(null);
    setDraft(current => current && ({ ...current, fallback_models: current.fallback_models.map((item, i) => i === index ? { ...item, ...patch } : item) }));
  }
  function move(index: number, delta: number) {
    setMessage(null);
    setDraft(current => {
      if (!current) return current;
      const fallback_models = [...current.fallback_models];
      [fallback_models[index], fallback_models[index + delta]] = [fallback_models[index + delta]!, fallback_models[index]!];
      return { ...current, fallback_models };
    });
  }
  async function save() {
    if (!draft || !payload || !ready || pending || !changed || conflict) return;
    setPending(true); setError(null); setMessage(null);
    try {
      const next = await service.write({ value: draft, expectedVersion: payload.version }, t);
      setPayload(next); setDraft(next.value); setMessage(t("jobs.common.saved"));
    } catch (caught) {
      if (caught instanceof CardApiError && caught.status === 409) setConflict(true);
      else setError(errorText(caught));
    } finally { setPending(false); }
  }
  return <form className="space-y-4" aria-label={t("jobs.defaults.title")} aria-busy={loading || pending} onSubmit={event => { event.preventDefault(); void save(); }}>
    {loading ? <FrameLoading inline label={t("jobs.common.loading")} /> : null}
    {loadError ? <p role="alert" className="text-destructive-foreground">{loadError}</p> : null}
    {draft && payload && catalog ? <>
      <p className="text-muted-foreground">{payload.source === "catalog" ? t("jobs.defaults.catalogSource") : t("jobs.defaults.savedSource")}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <NodeModelPresetSelect nodeId={catalog.nodeId} value={draft.model_preset} label={t("jobs.common.defaultModel")} className="v3-model-preset-field" triggerClassName="v3-model-preset-trigger" modelPresetCatalog={catalog} missingPresetLabel={missingLabel} disabled={pending || !ready} onValueChange={model_preset => { setMessage(null); setDraft({ ...draft, model_preset }); }}/>
      </div>
      <div className={draft.fallback_models.length ? "space-y-3 pt-2" : "space-y-3"}>
      <div className="space-y-6">
      {draft.fallback_models.map((item, index) => {
        const efforts = catalog.presets.find(preset => preset.id === item.model_preset)?.supported_efforts ?? [];
        const effortOptions = [...efforts];
        if (item.reasoning_effort && !effortOptions.includes(item.reasoning_effort)) effortOptions.unshift(item.reasoning_effort);
        return <fieldset key={index} className="space-y-2" disabled={pending || !ready}>
          <legend>{t("jobs.defaults.fallbackNumber", { number: index + 1 })}</legend>
          <div className="space-y-3">
          <div className="grid gap-3 sm:gap-4 sm:grid-cols-2">
            <NodeModelPresetSelect nodeId={catalog.nodeId} value={item.model_preset} label={t("jobs.common.model")} ariaLabel={t("jobs.defaults.fallbackModel", { number: index + 1 })} className="v3-model-preset-field" triggerClassName="v3-model-preset-trigger" modelPresetCatalog={catalog} missingPresetLabel={missingLabel} disabled={pending || !ready} onValueChange={model_preset => updateFallback(index, { model_preset, reasoning_effort: null })}/>
            <CatalogSelectionField label={t("jobs.defaults.effort")} ariaLabel={t("jobs.defaults.fallbackEffort", { number: index + 1 })} value={item.reasoning_effort ?? ""} selectedLabel={item.reasoning_effort ?? t("jobs.defaults.presetDefault")} disabled={pending || !ready} options={[{ value: "", label: t("jobs.defaults.presetDefault") }, ...effortOptions.map(effort => ({ value: effort, label: effort }))]} onValueChange={reasoning_effort => updateFallback(index, { reasoning_effort: reasoning_effort || null })}/>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" aria-label={t("jobs.defaults.moveUp", { number: index + 1 })} disabled={pending || index === 0} onClick={() => move(index, -1)}>{t("jobs.common.up")}</Button>
            <Button type="button" variant="outline" aria-label={t("jobs.defaults.moveDown", { number: index + 1 })} disabled={pending || index === draft.fallback_models.length - 1} onClick={() => move(index, 1)}>{t("jobs.common.down")}</Button>
            <Button type="button" variant="outline" aria-label={t("jobs.defaults.removeFallback", { number: index + 1 })} disabled={pending} onClick={() => { setMessage(null); setDraft({ ...draft, fallback_models: draft.fallback_models.filter((_, i) => i !== index) }); }}>{t("jobs.common.remove")}</Button>
          </div>
          </div>
        </fieldset>;
      })}
      </div>
      <Button type="button" variant="outline" disabled={pending || !ready || draft.fallback_models.length >= PERSISTENT_FALLBACK_MODELS_MAX} onClick={() => { setMessage(null); setDraft({ ...draft, fallback_models: [...draft.fallback_models, { model_preset: "", reasoning_effort: null }] }); }}>{t("jobs.defaults.addFallback")}</Button>
      </div>
    </> : null}
    {conflict ? <p role="alert" className="text-destructive-foreground">{t("jobs.common.conflict")}</p> : null}
    {error ? <p role="alert" className="text-destructive-foreground">{error}</p> : null}
    {message ? <p role="status">{message}</p> : null}
    {!loading ? <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" disabled={pending || loading} onClick={() => void load()}>{t("jobs.common.reload")}</Button>
      <Button type="submit" disabled={!changed || !ready || pending || loading || conflict}>{pending ? t("jobs.common.saving") : t("jobs.defaults.save")}</Button>
    </div> : null}
  </form>;
}
