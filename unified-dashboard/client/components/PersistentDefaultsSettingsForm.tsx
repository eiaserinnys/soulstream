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
export interface PersistentDefaultsSettingsService {
  read(): Promise<PersistentDefaultsPayload>;
  write(input: { value: PersistentDefaultsValue; expectedVersion: number }): Promise<PersistentDefaultsPayload>;
  presets(): Promise<NodeModelPresetCatalog>;
}
const endpoint = "/api/admin/settings/persistent-defaults";
const defaultService: PersistentDefaultsSettingsService = {
  read: async () => {
    try { return await cardRequest(endpoint); }
    catch (error) {
      if (error instanceof CardApiError && error.message === `카드 요청 실패 (${error.status})`) {
        throw new Error(`기본 모델 설정을 불러오지 못했습니다 (${error.status})`);
      }
      throw error;
    }
  },
  write: (input) => cardRequest(endpoint, "PUT", input),
  presets: async () => {
    const { create_defaults } = await createPersistentSessionsApi().list();
    const nodeId = create_defaults?.node_id;
    if (!nodeId) throw new Error("기본 실행 노드를 불러오지 못했습니다.");
    const presets = await fetchNodeModelPresets(nodeId);
    return { nodeId, presets, status: "ready" };
  },
};
const missingLabel = (id: string) => id;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function PersistentDefaultsSettingsForm({ service = defaultService }: { service?: PersistentDefaultsSettingsService } = {}) {
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
      const [next, available] = await Promise.all([service.read(), service.presets()]);
      setPayload(next); setDraft(next.value); setCatalog(available); setConflict(false);
    } catch (caught) {
      setCatalog(null); setLoadError(errorText(caught));
    } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [service]);
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
      const next = await service.write({ value: draft, expectedVersion: payload.version });
      setPayload(next); setDraft(next.value); setMessage("저장했습니다.");
    } catch (caught) {
      if (caught instanceof CardApiError && caught.status === 409) setConflict(true);
      else setError(errorText(caught));
    } finally { setPending(false); }
  }
  return <form className="space-y-4" aria-label="영구 세션 기본 모델" aria-busy={loading || pending} onSubmit={event => { event.preventDefault(); void save(); }}>
    {loading ? <FrameLoading inline label="불러오는 중…" /> : null}
    {loadError ? <p role="alert" className="text-destructive-foreground">{loadError}</p> : null}
    {draft && payload && catalog ? <>
      <p className="text-muted-foreground">{payload.source === "catalog" ? "카탈로그 기본값을 쓰는 중" : "저장한 설정을 쓰는 중"}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <NodeModelPresetSelect nodeId={catalog.nodeId} value={draft.model_preset} label="기본 모델" className="v3-model-preset-field" triggerClassName="v3-model-preset-trigger" modelPresetCatalog={catalog} missingPresetLabel={missingLabel} disabled={pending || !ready} onValueChange={model_preset => { setMessage(null); setDraft({ ...draft, model_preset }); }}/>
      </div>
      <div className={draft.fallback_models.length ? "space-y-3 pt-2" : "space-y-3"}>
      <div className="space-y-6">
      {draft.fallback_models.map((item, index) => {
        const efforts = catalog.presets.find(preset => preset.id === item.model_preset)?.supported_efforts ?? [];
        const effortOptions = [...efforts];
        if (item.reasoning_effort && !effortOptions.includes(item.reasoning_effort)) effortOptions.unshift(item.reasoning_effort);
        return <fieldset key={index} className="space-y-2" disabled={pending || !ready}>
          <legend>대체 {index + 1}</legend>
          <div className="space-y-3">
          <div className="grid gap-3 sm:gap-4 sm:grid-cols-2">
            <NodeModelPresetSelect nodeId={catalog.nodeId} value={item.model_preset} label="모델" ariaLabel={`대체 ${index + 1} 모델`} className="v3-model-preset-field" triggerClassName="v3-model-preset-trigger" modelPresetCatalog={catalog} missingPresetLabel={missingLabel} disabled={pending || !ready} onValueChange={model_preset => updateFallback(index, { model_preset, reasoning_effort: null })}/>
            <CatalogSelectionField label="노력" ariaLabel={`대체 ${index + 1} 노력`} value={item.reasoning_effort ?? ""} selectedLabel={item.reasoning_effort ?? "프리셋 기본"} disabled={pending || !ready} options={[{ value: "", label: "프리셋 기본" }, ...effortOptions.map(effort => ({ value: effort, label: effort }))]} onValueChange={reasoning_effort => updateFallback(index, { reasoning_effort: reasoning_effort || null })}/>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" aria-label={`대체 ${index + 1} 위로`} disabled={pending || index === 0} onClick={() => move(index, -1)}>위로</Button>
            <Button type="button" variant="outline" aria-label={`대체 ${index + 1} 아래로`} disabled={pending || index === draft.fallback_models.length - 1} onClick={() => move(index, 1)}>아래로</Button>
            <Button type="button" variant="outline" aria-label={`대체 ${index + 1} 제거`} disabled={pending} onClick={() => { setMessage(null); setDraft({ ...draft, fallback_models: draft.fallback_models.filter((_, i) => i !== index) }); }}>제거</Button>
          </div>
          </div>
        </fieldset>;
      })}
      </div>
      <Button type="button" variant="outline" disabled={pending || !ready || draft.fallback_models.length >= PERSISTENT_FALLBACK_MODELS_MAX} onClick={() => { setMessage(null); setDraft({ ...draft, fallback_models: [...draft.fallback_models, { model_preset: "", reasoning_effort: null }] }); }}>대체 모델 추가</Button>
      </div>
    </> : null}
    {conflict ? <p role="alert" className="text-destructive-foreground">다른 곳에서 먼저 바뀌었습니다. 다시 불러와 주세요.</p> : null}
    {error ? <p role="alert" className="text-destructive-foreground">{error}</p> : null}
    {message ? <p role="status">{message}</p> : null}
    {!loading ? <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" disabled={pending || loading} onClick={() => void load()}>다시 불러오기</Button>
      <Button type="submit" disabled={!changed || !ready || pending || loading || conflict}>{pending ? "저장 중…" : "기본 모델 저장"}</Button>
    </div> : null}
  </form>;
}
