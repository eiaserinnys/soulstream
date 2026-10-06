import { useState } from "react";
import type { ModelPresetAvailability } from "@seosoyoung/soul-ui";

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

const modelAvailability: ModelPresetAvailability[] = [
  { id: "sample-opus", label: "Opus", backend: "claude", available: true, reason: null, reason_label: null, resets_at: "2026-10-08T00:00:00.000Z", usage_warning: false,
    weekly_headroom: { status: "ok", headroom: 12.5, remaining_percent: 72.5, window_remaining_percent: 60, resets_at: "2026-10-08T00:00:00.000Z", observed_at: "2026-10-06T02:00:00.000Z", quota_label: "7일" } },
  { id: "sample-sol", label: "Sol", backend: "codex", available: true, reason: null, reason_label: null, resets_at: null, usage_warning: false,
    weekly_headroom: { status: "ok", headroom: -56.6, remaining_percent: 21, window_remaining_percent: 77.6, resets_at: null, observed_at: "2026-10-06T02:01:00.000Z", quota_label: "7일" } },
];

export function PersistentSessionSettingsReviewSample() {
  const [draft, setDraft] = useState(() => persistentSessionDetailsDraft(resource));
  const monitorRequest = (result: "values" | "empty" | "loading" | "error"): typeof fetch => async (input) => {
    const url = new URL(String(input), "https://sample.invalid");
    if (url.pathname.endsWith("/model-presets")) return Response.json({ model_presets: result === "values" ? modelAvailability : [] });
    if (result === "loading") return await new Promise<Response>(() => undefined);
    if (result === "error") return new Response("unavailable", { status: 503 });
    const messages = result === "values" ? [
      { id: 106, event_type: "complete", payload: { usage: { input_tokens: 14320, output_tokens: 2840 }, turn_cost_usd: 0.62 }, created_at: "2026-10-06T03:40:12.418Z" },
      { id: 105, event_type: "user_message", payload: { text: "요약해 주세요." }, created_at: "2026-10-06T03:39:00.000Z" },
      { id: 104, event_type: "context_usage", payload: { used_tokens: 326000, max_tokens: 1000000, percent: 32.6, estimated: false }, created_at: "2026-10-06T03:38:00.000Z" },
      { id: 103, event_type: "generation_started", payload: { generation: 7, reason: "weekly_headroom", current: { model: "gpt-6.1-sol-preview-2026-09-30-long" } }, created_at: "2026-10-06T03:18:12.418Z" },
      { id: 102, event_type: "complete", payload: { usage: { input_tokens: 8900, output_tokens: 1200 }, turn_cost_usd: 0.31 }, created_at: "2026-10-06T02:30:00.000Z" },
      { id: 101, event_type: "context_usage", payload: { used_tokens: 124000, max_tokens: 1000000, percent: 12.4, estimated: false }, created_at: "2026-10-06T02:29:00.000Z" },
      { id: 100, event_type: "generation_started", payload: { generation: 6, reason: "weekly_headroom", current: { model: "gpt-6.1-sol-preview-2026-09-30-long" } }, created_at: "2026-10-06T02:00:00.000Z" },
    ] : [];
    const eventTypes = url.searchParams.get("event_types")?.split(",");
    const filtered = eventTypes ? messages.filter((message) => eventTypes.includes(message.event_type)) : messages;
    return Response.json({ messages: filtered, next_cursor: null });
  };

  return <div className="space-y-4">
    <PersistentSessionDetails
      resource={resource}
      draft={draft}
      pending={false}
      error={null}
      modelPresetCatalog={modelPresetCatalog}
      weeklyAvailability={modelAvailability}
      onFieldChange={(field, value) => setDraft((current) => ({ ...current, [field]: value }))}
      onSave={() => undefined}
    />
    <div className="grid gap-4">
      <section aria-label="값 있음">
        <h4 className="mb-2 text-sm font-medium">값 있음</h4>
        <PersistentSessionMonitoring sessionId={resource.session_id} nodeId="sample-node" request={monitorRequest("values")} />
      </section>
      <section aria-label="기록 없음">
        <h4 className="mb-2 text-sm font-medium">기록 없음</h4>
        <PersistentSessionMonitoring sessionId={resource.session_id} nodeId="sample-node" request={monitorRequest("empty")} />
      </section>
      <section aria-label="불러오는 중">
        <h4 className="mb-2 text-sm font-medium">불러오는 중</h4>
        <PersistentSessionMonitoring sessionId="components-pas-loading" nodeId="sample-node" request={monitorRequest("loading")} />
      </section>
      <section aria-label="조회 실패">
        <h4 className="mb-2 text-sm font-medium">조회 실패</h4>
        <PersistentSessionMonitoring sessionId="components-pas-failed" nodeId="sample-node" request={monitorRequest("error")} />
      </section>
    </div>
  </div>;
}
