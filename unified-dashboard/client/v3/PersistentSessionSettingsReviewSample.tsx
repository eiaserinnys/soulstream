import { useState } from "react";

import { PersistentSessionDetails, persistentSessionDetailsDraft } from "../components/PersistentSessionDetails";
import { PersistentSessionMonitoring } from "../components/PersistentSessionMonitoring";
import type { PersistentSession } from "../lib/persistent-sessions";

const resource: PersistentSession = {
  session_id: "components-pas-review",
  display_name: "검수 관제",
  node_id: "sample-node",
  folder_id: "sample-folder",
  agent_id: "roselin",
  agent_name: "로젤린",
  persistent: true,
  settings: {
    default_model: { model_preset: "sample-opus", reasoning_effort: null },
    fallback_model: null,
    show_generation_separator: true,
    show_character: true,
    animate_character: true,
    show_jev_candidates: true,
    show_turn_usage: true,
  },
  runtime: {
    current_model: { model_preset: "sample-sol", reasoning_effort: "high", model: "sample-sol-model" },
    pending: { target_model_preset: "sample-opus", target_reasoning_effort: null },
  },
};

const modelPresetCatalog = {
  status: "ready" as const,
  nodeId: "sample-node",
  presets: [
    { id: "sample-opus", label: "Opus", backend: "claude", available: true, reason: null, reason_label: null, resets_at: null, usage_warning: false },
    { id: "sample-sol", label: "Sol", backend: "codex", available: true, reason: null, reason_label: null, resets_at: null, usage_warning: false },
  ],
};

export function PersistentSessionSettingsReviewSample() {
  const [draft, setDraft] = useState(() => persistentSessionDetailsDraft(resource));
  const monitorRequest = (result: "empty" | "loading" | "error"): typeof fetch => async () => {
    if (result === "loading") return await new Promise<Response>(() => undefined);
    if (result === "error") return new Response("unavailable", { status: 503 });
    return Response.json({ messages: [], next_cursor: null });
  };

  return <div className="space-y-4">
    <PersistentSessionDetails
      resource={resource}
      draft={draft}
      pending={false}
      error={null}
      modelPresetCatalog={modelPresetCatalog}
      onFieldChange={(field, value) => setDraft((current) => ({ ...current, [field]: value }))}
      onSave={() => undefined}
    />
    <div className="grid gap-4">
      <section aria-label="기록 없음">
        <h4 className="mb-2 text-sm font-medium">기록 없음</h4>
        <PersistentSessionMonitoring resource={resource} sessionId={resource.session_id} nodeId="sample-node" request={monitorRequest("empty")} />
      </section>
      <section aria-label="불러오는 중">
        <h4 className="mb-2 text-sm font-medium">불러오는 중</h4>
        <PersistentSessionMonitoring resource={resource} sessionId="components-pas-loading" nodeId="sample-node" request={monitorRequest("loading")} />
      </section>
      <section aria-label="조회 실패">
        <h4 className="mb-2 text-sm font-medium">조회 실패</h4>
        <PersistentSessionMonitoring resource={resource} sessionId="components-pas-failed" nodeId="sample-node" request={monitorRequest("error")} />
      </section>
    </div>
  </div>;
}
