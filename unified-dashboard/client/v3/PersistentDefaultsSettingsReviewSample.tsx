import { useMemo, useState } from "react";
import { Button } from "@seosoyoung/soul-ui";
import { CardApiError } from "@seosoyoung/soul-ui/cards/card-api";
import { PersistentDefaultsSettingsForm, type PersistentDefaultsPayload, type PersistentDefaultsSettingsService } from "../components/PersistentDefaultsSettingsForm";

const preset = (id: string, label: string, supported_efforts: string[]) => ({ id, label, supported_efforts, backend: "sample", available: true, reason: null, reason_label: null, resets_at: null, usage_warning: false });
const presets = [preset("sample-a", "모델 알파", ["low", "high"]), preset("sample-b", "모델 베타", ["medium", "high"]), preset("sample-c", "모델 감마", ["high"]), preset("sample-d", "모델 델타", [])];
type Scene = "catalog" | "settings" | "conflict";
export function PersistentDefaultsSettingsReviewSample() {
  const [scene, setScene] = useState<Scene>("catalog");
  const service = useMemo<PersistentDefaultsSettingsService>(() => {
    let current: PersistentDefaultsPayload = {
      value: { model_preset: "sample-a", fallback_models: scene === "catalog" ? [] : [
        { model_preset: "sample-b", reasoning_effort: "medium" },
        { model_preset: "sample-c", reasoning_effort: "high" },
        { model_preset: "sample-d", reasoning_effort: null },
      ] }, version: 1, source: scene === "catalog" ? "catalog" : "settings",
    };
    return {
      read: async () => structuredClone(current),
      presets: async () => ({ nodeId: "sample-node", presets, status: "ready" }),
      write: async ({ value, expectedVersion }) => {
        if (scene === "conflict") throw new CardApiError("충돌", 409);
        current = { value, version: expectedVersion + 1, source: "settings" };
        return structuredClone(current);
      },
    };
  }, [scene]);
  return <div className="space-y-4">
    <div className="flex flex-wrap gap-2" aria-label="견본 상태">
      <Button type="button" variant="outline" onClick={() => setScene("catalog")}>카탈로그 견본</Button>
      <Button type="button" variant="outline" onClick={() => setScene("settings")}>저장된 설정 견본</Button>
      <Button type="button" variant="outline" onClick={() => setScene("conflict")}>충돌 견본</Button>
    </div>
    <PersistentDefaultsSettingsForm key={scene} service={service}/>
  </div>;
}
