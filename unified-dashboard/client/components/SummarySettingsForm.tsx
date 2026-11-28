import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, FrameLoading, Switch } from "@seosoyoung/soul-ui";
import { CardApiError, cardRequest } from "@seosoyoung/soul-ui/cards/card-api";
import type { NodeModelPresetCatalog } from "../lib/use-node-model-preset-catalog";
import { NodeModelPresetSelect } from "./NodeModelPresetSelect";
import { loadDefaultNodeModelPresets } from "./PersistentDefaultsSettingsForm";

export type SummaryPart = { enabled: boolean; model_presets: string[] };
export type SummarySettingsValue = { turn: SummaryPart; session: SummaryPart };
export type SummarySettingsPayload = {
  value: SummarySettingsValue;
  version: number;
  source: "default" | "settings";
  updated_at: string | null;
  updated_by: string | null;
  selectable_preset_ids: string[];
};
type Translate = ReturnType<typeof useTranslation>["t"];

export interface SummarySettingsService {
  read(t: Translate): Promise<SummarySettingsPayload>;
  write(input: { value: SummarySettingsValue; expectedVersion: number }): Promise<SummarySettingsPayload>;
  presets(t: Translate): Promise<NodeModelPresetCatalog>;
}

export const SUMMARY_MODELS_MAX = 5;
const endpoint = "/api/admin/settings/summaries";
const defaultService: SummarySettingsService = {
  read: async (t) => {
    try { return await cardRequest(endpoint); }
    catch (error) {
      if (error instanceof CardApiError && error.message === `카드 요청 실패 (${error.status})`) { // i18n-ignore: 공용 카드 API가 만든 오류 문구와 비교합니다.
        throw new Error(t("jobs.summary.loadError", { status: error.status }));
      }
      throw error;
    }
  },
  write: (input) => cardRequest(endpoint, "PUT", input),
  presets: loadDefaultNodeModelPresets,
};

const PARTS = [
  { key: "turn", titleKey: "jobs.summary.turn" },
  { key: "session", titleKey: "jobs.summary.session" },
] as const;
type PartKey = (typeof PARTS)[number]["key"];

const missingLabel = (id: string) => id;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** 저장 전에 서버가 거절할 두 경우를 먼저 막는다: 켰는데 목록이 비었거나, 모델을 고르지 않은 칸이 있다. */
function draftProblem(value: SummarySettingsValue, t: Translate): string | null {
  for (const { key, titleKey } of PARTS) {
    const title = t(titleKey);
    const part = value[key];
    if (part.model_presets.some(id => id === "")) return t("jobs.summary.missingModel", { title });
    if (part.enabled && part.model_presets.length === 0) return t("jobs.summary.emptyEnabled", { title });
  }
  return null;
}

export function SummarySettingsForm({ service = defaultService }: { service?: SummarySettingsService } = {}) {
  const { t } = useTranslation();
  const [payload, setPayload] = useState<SummarySettingsPayload | null>(null);
  const [draft, setDraft] = useState<SummarySettingsValue | null>(null);
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
  useEffect(() => { void load(); }, [service]);

  const selectable = useMemo(() => {
    if (!catalog || !payload) return null;
    const ids = new Set(payload.selectable_preset_ids);
    return { ...catalog, presets: catalog.presets.filter(preset => ids.has(preset.id)) };
  }, [catalog, payload]);
  const changed = Boolean(draft && payload && JSON.stringify(draft) !== JSON.stringify(payload.value));
  const ready = selectable?.status === "ready";

  function updatePart(key: PartKey, change: (part: SummaryPart) => SummaryPart) {
    setMessage(null); setError(null);
    setDraft(current => current && ({ ...current, [key]: change(current[key]) }));
  }
  function move(key: PartKey, index: number, delta: number) {
    updatePart(key, part => {
      const model_presets = [...part.model_presets];
      [model_presets[index], model_presets[index + delta]] = [model_presets[index + delta]!, model_presets[index]!];
      return { ...part, model_presets };
    });
  }
  async function save() {
    if (!draft || !payload || !ready || pending || !changed || conflict) return;
    const problem = draftProblem(draft, t);
    if (problem) { setError(problem); setMessage(null); return; }
    setPending(true); setError(null); setMessage(null);
    try {
      const next = await service.write({ value: draft, expectedVersion: payload.version });
      setPayload(next); setDraft(next.value); setMessage(t("jobs.common.saved"));
    } catch (caught) {
      if (caught instanceof CardApiError && caught.status === 409) setConflict(true);
      else setError(errorText(caught));
    } finally { setPending(false); }
  }

  return <form className="space-y-4" aria-label={t("jobs.summary.title")} aria-busy={loading || pending} onSubmit={event => { event.preventDefault(); void save(); }}>
    {loading ? <FrameLoading inline label={t("jobs.common.loading")} /> : null}
    {loadError ? <p role="alert" className="text-destructive-foreground">{loadError}</p> : null}
    {draft && payload && selectable ? <div className="space-y-8">
      {PARTS.map(({ key, titleKey }) => {
        const title = t(titleKey);
        const part = draft[key];
        return <section key={key} className="space-y-4" aria-label={title}>
          <h3 className="font-semibold">{title}</h3>
          <label className="flex items-center justify-between gap-4 text-sm">
            <span>{t("jobs.summary.enabled")}</span>
            <Switch aria-label={t("jobs.summary.enablePart", { title })} checked={part.enabled} disabled={pending || !ready} onCheckedChange={enabled => updatePart(key, current => ({ ...current, enabled }))}/>
          </label>
          {key === "session" ? <p className="text-sm text-muted-foreground">{t("jobs.summary.sessionHelp")}</p> : null}
          <p className="text-sm text-muted-foreground">{t("jobs.summary.modelOrder")}</p>
          <div className="space-y-6">
            {part.model_presets.map((presetId, index) => <fieldset key={index} className="space-y-3" disabled={pending || !ready}>
              <NodeModelPresetSelect nodeId={selectable.nodeId} value={presetId} label={t("jobs.summary.modelNumber", { number: index + 1 })} ariaLabel={t("jobs.summary.partModel", { title, number: index + 1 })} className="v3-model-preset-field" triggerClassName="v3-model-preset-trigger" modelPresetCatalog={selectable} missingPresetLabel={missingLabel} disabled={pending || !ready} onValueChange={next => updatePart(key, current => ({ ...current, model_presets: current.model_presets.map((id, i) => i === index ? next : id) }))}/>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" aria-label={t("jobs.summary.moveUp", { title, number: index + 1 })} disabled={pending || index === 0} onClick={() => move(key, index, -1)}>{t("jobs.common.up")}</Button>
                <Button type="button" variant="outline" aria-label={t("jobs.summary.moveDown", { title, number: index + 1 })} disabled={pending || index === part.model_presets.length - 1} onClick={() => move(key, index, 1)}>{t("jobs.common.down")}</Button>
                <Button type="button" variant="outline" aria-label={t("jobs.summary.removeModel", { title, number: index + 1 })} disabled={pending} onClick={() => updatePart(key, current => ({ ...current, model_presets: current.model_presets.filter((_, i) => i !== index) }))}>{t("jobs.common.remove")}</Button>
              </div>
            </fieldset>)}
          </div>
          <Button type="button" variant="outline" aria-label={t("jobs.summary.addPartModel", { title })} disabled={pending || !ready || part.model_presets.length >= SUMMARY_MODELS_MAX} onClick={() => updatePart(key, current => ({ ...current, model_presets: [...current.model_presets, ""] }))}>{t("jobs.summary.addModel")}</Button>
        </section>;
      })}
    </div> : null}
    {conflict ? <p role="alert" className="text-destructive-foreground">{t("jobs.common.conflict")}</p> : null}
    {error ? <p role="alert" className="text-destructive-foreground">{error}</p> : null}
    {message ? <p role="status">{message}</p> : null}
    {!loading ? <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" disabled={pending || loading} onClick={() => void load()}>{t("jobs.common.reload")}</Button>
      <Button type="submit" disabled={!changed || !ready || pending || loading || conflict}>{pending ? t("jobs.common.saving") : t("jobs.summary.save")}</Button>
    </div> : null}
  </form>;
}
