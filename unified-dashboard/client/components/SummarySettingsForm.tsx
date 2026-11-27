import { useEffect, useMemo, useState } from "react";
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
export interface SummarySettingsService {
  read(): Promise<SummarySettingsPayload>;
  write(input: { value: SummarySettingsValue; expectedVersion: number }): Promise<SummarySettingsPayload>;
  presets(): Promise<NodeModelPresetCatalog>;
}

export const SUMMARY_MODELS_MAX = 5;
const endpoint = "/api/admin/settings/summaries";
const defaultService: SummarySettingsService = {
  read: async () => {
    try { return await cardRequest(endpoint); }
    catch (error) {
      if (error instanceof CardApiError && error.message === `카드 요청 실패 (${error.status})`) {
        throw new Error(`요약 설정을 불러오지 못했습니다 (${error.status})`);
      }
      throw error;
    }
  },
  write: (input) => cardRequest(endpoint, "PUT", input),
  presets: loadDefaultNodeModelPresets,
};

const PARTS = [
  { key: "turn", title: "턴 요약", note: null },
  { key: "session", title: "세션 요약", note: "턴 요약을 모아 세션 줄거리를 만듭니다. 턴 요약이 꺼져 있으면 새 재료가 쌓이지 않습니다." },
] as const;
type PartKey = (typeof PARTS)[number]["key"];

const ORDER_NOTE = "위에서부터 차례로 쓰고, 사용량 한도에 걸리거나 쓸 수 없을 때만 다음 모델로 넘어갑니다.";
const missingLabel = (id: string) => id;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** 저장 전에 서버가 거절할 두 경우를 먼저 막는다: 켰는데 목록이 비었거나, 모델을 고르지 않은 칸이 있다. */
function draftProblem(value: SummarySettingsValue): string | null {
  for (const { key, title } of PARTS) {
    const part = value[key];
    if (part.model_presets.some(id => id === "")) return `${title}: 모델을 고르지 않은 칸이 있습니다.`;
    if (part.enabled && part.model_presets.length === 0) return `${title}: 켜려면 모델을 하나 이상 골라 주세요.`;
  }
  return null;
}

export function SummarySettingsForm({ service = defaultService }: { service?: SummarySettingsService } = {}) {
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
      const [next, available] = await Promise.all([service.read(), service.presets()]);
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
    const problem = draftProblem(draft);
    if (problem) { setError(problem); setMessage(null); return; }
    setPending(true); setError(null); setMessage(null);
    try {
      const next = await service.write({ value: draft, expectedVersion: payload.version });
      setPayload(next); setDraft(next.value); setMessage("저장했습니다.");
    } catch (caught) {
      if (caught instanceof CardApiError && caught.status === 409) setConflict(true);
      else setError(errorText(caught));
    } finally { setPending(false); }
  }

  return <form className="space-y-4" aria-label="요약" aria-busy={loading || pending} onSubmit={event => { event.preventDefault(); void save(); }}>
    {loading ? <FrameLoading inline label="불러오는 중…" /> : null}
    {loadError ? <p role="alert" className="text-destructive-foreground">{loadError}</p> : null}
    {draft && payload && selectable ? <div className="space-y-8">
      {PARTS.map(({ key, title, note }) => {
        const part = draft[key];
        return <section key={key} className="space-y-4" aria-label={title}>
          <h3 className="font-semibold">{title}</h3>
          <label className="flex items-center justify-between gap-4 text-sm">
            <span>사용</span>
            <Switch aria-label={`${title} 사용`} checked={part.enabled} disabled={pending || !ready} onCheckedChange={enabled => updatePart(key, current => ({ ...current, enabled }))}/>
          </label>
          {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}
          <p className="text-sm text-muted-foreground">{ORDER_NOTE}</p>
          <div className="space-y-6">
            {part.model_presets.map((presetId, index) => <fieldset key={index} className="space-y-3" disabled={pending || !ready}>
              <NodeModelPresetSelect nodeId={selectable.nodeId} value={presetId} label={`${index + 1}번째 모델`} ariaLabel={`${title} ${index + 1}번째 모델`} className="v3-model-preset-field" triggerClassName="v3-model-preset-trigger" modelPresetCatalog={selectable} missingPresetLabel={missingLabel} disabled={pending || !ready} onValueChange={next => updatePart(key, current => ({ ...current, model_presets: current.model_presets.map((id, i) => i === index ? next : id) }))}/>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" aria-label={`${title} ${index + 1}번째 모델 위로`} disabled={pending || index === 0} onClick={() => move(key, index, -1)}>위로</Button>
                <Button type="button" variant="outline" aria-label={`${title} ${index + 1}번째 모델 아래로`} disabled={pending || index === part.model_presets.length - 1} onClick={() => move(key, index, 1)}>아래로</Button>
                <Button type="button" variant="outline" aria-label={`${title} ${index + 1}번째 모델 제거`} disabled={pending} onClick={() => updatePart(key, current => ({ ...current, model_presets: current.model_presets.filter((_, i) => i !== index) }))}>제거</Button>
              </div>
            </fieldset>)}
          </div>
          <Button type="button" variant="outline" aria-label={`${title} 모델 추가`} disabled={pending || !ready || part.model_presets.length >= SUMMARY_MODELS_MAX} onClick={() => updatePart(key, current => ({ ...current, model_presets: [...current.model_presets, ""] }))}>모델 추가</Button>
        </section>;
      })}
    </div> : null}
    {conflict ? <p role="alert" className="text-destructive-foreground">다른 곳에서 먼저 바뀌었습니다. 다시 불러와 주세요.</p> : null}
    {error ? <p role="alert" className="text-destructive-foreground">{error}</p> : null}
    {message ? <p role="status">{message}</p> : null}
    {!loading ? <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" disabled={pending || loading} onClick={() => void load()}>다시 불러오기</Button>
      <Button type="submit" disabled={!changed || !ready || pending || loading || conflict}>{pending ? "저장 중…" : "요약 설정 저장"}</Button>
    </div> : null}
  </form>;
}
