import { useMemo, useState } from "react";
import { Button } from "@seosoyoung/soul-ui";
import { CardApiError } from "@seosoyoung/soul-ui/cards/card-api";
import { SummarySettingsForm, type SummarySettingsPayload, type SummarySettingsService } from "../components/SummarySettingsForm";

const preset = (id: string, label: string, backend: string) => ({ id, label, backend, available: true, reason: null, reason_label: null, resets_at: null, usage_warning: false });
const presets = [
  preset("sample-claude", "Claude - 샘플", "claude"),
  preset("sample-agy", "Antigravity - 샘플", "antigravity"),
  preset("sample-codex-a", "Codex - 샘플 A", "codex"),
  preset("sample-codex-b", "Codex - 샘플 B", "codex"),
];
const selectable_preset_ids = presets.map(item => item.id);
type Scene = "default" | "operating" | "conflict" | "invalid";

const initial = (scene: Scene): SummarySettingsPayload => scene === "default"
  ? { value: { turn: { enabled: false, model_presets: [] }, session: { enabled: false, model_presets: [] } }, version: 0, source: "default", updated_at: null, updated_by: null, selectable_preset_ids }
  : {
    value: {
      turn: { enabled: true, model_presets: ["sample-claude", "sample-agy", "sample-codex-a"] },
      session: { enabled: true, model_presets: ["sample-claude", "sample-codex-b"] },
    },
    version: 4, source: "settings", updated_at: "2026-11-27T09:00:00.000Z", updated_by: "admin@example.com", selectable_preset_ids,
  };

export function SummarySettingsReviewSample() {
  const [scene, setScene] = useState<Scene>("default");
  const service = useMemo<SummarySettingsService>(() => {
    let current = initial(scene);
    return {
      read: async () => structuredClone(current),
      presets: async () => ({ nodeId: "sample-node", presets, status: "ready" }),
      write: async ({ value, expectedVersion }) => {
        if (scene === "conflict") throw new CardApiError("충돌", 409);
        if (scene === "invalid") throw new Error("턴 요약: 같은 모델을 두 번 넣을 수 없습니다 (sample-claude).");
        current = { ...current, value, version: expectedVersion + 1, source: "settings" };
        return structuredClone(current);
      },
    };
  }, [scene]);
  return <div className="space-y-4">
    <div className="flex flex-wrap gap-2" aria-label="견본 상태">
      <Button type="button" variant="outline" onClick={() => setScene("default")}>기본 꺼짐 견본</Button>
      <Button type="button" variant="outline" onClick={() => setScene("operating")}>운영 순서 견본</Button>
      <Button type="button" variant="outline" onClick={() => setScene("conflict")}>충돌 견본</Button>
      <Button type="button" variant="outline" onClick={() => setScene("invalid")}>서버 거절 견본</Button>
    </div>
    <SummarySettingsForm key={scene} service={service}/>
  </div>;
}
