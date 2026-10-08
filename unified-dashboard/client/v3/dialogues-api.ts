import type { ConfigModalApi } from "../components/ConfigModal";
import { createOwnedAgentsFixture } from "./owned-agents-fixture";
import { createPersistentSessionsFixture } from "./persistent-sessions-fixture";
import type { SessionStory } from "@seosoyoung/soul-ui";
import type { RecurringJob, RecurringJobRun } from "../lib/recurring-jobs";
import type { AssignmentData } from "./AgentNodeAssignmentFields";
import { reviewFolder, reviewFolders } from "./components-review-fixtures";
const now = "2026-10-03T00:00:00Z";
const persistentSettingsTimeline = [
  { id: 106, event_type: "complete", payload: { usage: { input_tokens: 14320, output_tokens: 2840 }, turn_cost_usd: 0.62 }, created_at: "2026-10-06T03:40:12.418Z" },
  { id: 105, event_type: "user_message", payload: { text: "요약해 주세요." }, created_at: "2026-10-06T03:39:00.000Z" },
  { id: 104, event_type: "context_usage", payload: { used_tokens: 326000, max_tokens: 1000000, percent: 32.6, estimated: false }, created_at: "2026-10-06T03:38:00.000Z" },
  { id: 103, event_type: "generation_started", payload: { generation: 7, reason: "weekly_headroom", current: { model: "gpt-6.1-sol-preview-2026-09-30-long" } }, created_at: "2026-10-06T03:18:12.418Z" },
  { id: 102, event_type: "complete", payload: { usage: { input_tokens: 8900, output_tokens: 1200 }, turn_cost_usd: 0.31 }, created_at: "2026-10-06T02:30:00.000Z" },
  { id: 101, event_type: "context_usage", payload: { used_tokens: 124000, max_tokens: 1000000, percent: 12.4, estimated: false }, created_at: "2026-10-06T02:29:00.000Z" },
  { id: 100, event_type: "generation_started", payload: { generation: 6, reason: "weekly_headroom", current: { model: "gpt-6.1-sol-preview-2026-09-30-long" } }, created_at: "2026-10-06T02:00:00.000Z" },
];
const persistentSettingsModelPresets = [
  { id: "sample-opus", label: "Opus", backend: "claude", available: true, reason: null, reason_label: null, resets_at: "2026-10-08T00:00:00.000Z", usage_warning: false,
    weekly_headroom: { status: "ok", headroom: 12.5, remaining_percent: 72.5, window_remaining_percent: 60, resets_at: "2026-10-08T00:00:00.000Z", observed_at: "2026-10-06T02:00:00.000Z", quota_label: "7일" } },
  { id: "sample-sol", label: "Sol", backend: "codex", available: true, reason: null, reason_label: null, resets_at: null, usage_warning: false,
    weekly_headroom: { status: "ok", headroom: -56.6, remaining_percent: 21, window_remaining_percent: 77.6, resets_at: null, observed_at: "2026-10-06T02:01:00.000Z", quota_label: "7일" } },
];
const persistentSettingsStory: SessionStory = {
  highlight: "설정 탭에서 확인하는 세션의 주요 결정입니다.",
  narrative: Array.from({ length: 36 }, (_, index) =>
    `스토리 구간 ${index + 1}: 대화의 전개와 결정된 내용을 설정 탭에서 확인합니다.`,
  ).join("\n\n"),
  unfolded_turn_summaries: [],
  narrative_through_event_id: 180,
  fold_count: 3,
  updated_at: "2026-10-08T00:00:00.000Z",
};
const persistentSettingsSummariesOnly: SessionStory = {
  highlight: null,
  narrative: null,
  unfolded_turn_summaries: [
    { event_id: 82, turn_number: 4, content: "첫 번째 요약에는 사용자가 정한 방향이 남아 있습니다.", turn_start_event_id: 77, final_response_event_id: 82, created_at: "2026-10-07T10:00:00.000Z" },
    { event_id: 91, turn_number: 5, content: "다음 요약에는 확인된 후속 결정이 남아 있습니다.", turn_start_event_id: 83, final_response_event_id: 91, created_at: "2026-10-07T11:00:00.000Z" },
  ],
  narrative_through_event_id: null,
  fold_count: 0,
  updated_at: "2026-10-07T11:00:00.000Z",
};
const persistentSettingsEmptyStory: SessionStory = {
  highlight: null,
  narrative: null,
  unfolded_turn_summaries: [],
  narrative_through_event_id: null,
  fold_count: 0,
  updated_at: null,
};
export const dialoguesFolders = reviewFolders.map((folder) => ({ ...folder, projectPageId: folder.id }));
export const dialoguesAssignment: AssignmentData = {
  nodes: [{ nodeId: "sample-node", status: "connected" }],
  agents: [
    {
      id: "roselin",
      name: "로젤린",
      backend: "codex",
      default_preset: "sample-sol",
      portraitUrl: "/system-portrait.png",
    },
  ],
  modelPresetCatalog: {
    status: "ready",
    nodeId: "sample-node",
    presets: [
      {
        id: "sample-sol",
        label: "Sol",
        backend: "codex",
        available: true,
        default_effort: "high",
        supported_efforts: ["low", "medium", "high"],
        reason: null,
        reason_label: null,
        resets_at: null,
        usage_warning: false,
      },
      {
        id: "sample-opus",
        label: "Opus",
        backend: "claude",
        available: true,
        reason: null,
        reason_label: null,
        resets_at: null,
        usage_warning: false,
      },
    ],
  },
};
/** A per-gallery in-memory API. Unknown routes fail instead of falling through to fetch. */
export function createDialoguesApi() {
  const local = {
    folder: structuredClone(dialoguesFolders[0]!),
    sessionName: "검수 이름",
    cards: [] as Array<{ title: string }>,
  };
  let configValue = "기본값";
  const page = reviewFolder("검수 프로젝트", dialoguesFolders[0]!.id).page;
  let blocks: Array<Record<string, unknown>> = [];
  let users = [
    {
      email: "sample@example.invalid",
      displayName: "검수 사용자",
      isAdmin: false,
      allowedFolderIds: [dialoguesFolders[0]!.id],
      createdAt: now,
      createdBy: "sample",
    },
  ];
  let profile = {
    agent_id: "roselin",
    name: "로젤린",
    context_bundles: [],
    atom_contexts: [],
    effective_atom_contexts: [],
    default_preset: "sample-sol",
    aliases: [],
    has_portrait: false,
    portrait: null,
    version: 1,
    created_at: now,
    updated_at: now,
  };
  let bundles: Record<string, unknown>[] = [];
  let document = {
    id: "sample-document",
    title: "검수 문서",
    body:
      "# 검수 문서\n\n실제 문서 편집기에서 입력하고 저장합니다.\n\n" +
      "문서의 줄바꿈과 스크롤을 확인합니다.\n\n".repeat(20),
    version: 1,
    created_at: now,
    updated_at: now,
  };
  let storage = {
    endpoint: "https://sample.invalid",
    bucket: "sample-bucket",
    accessKeyId: "sample-key",
    secretAccessKeyConfigured: true,
    version: 1,
  };
  let policy = { key: "session_review", sourceAllowlist: ["agent"], version: 1, updatedAt: now, updatedBy: "sample" };
  let dispatch = { version: 1, nodeConcurrency: { default: 2, "sample-node": 1 } };
  let orchestration: import("../components/CardOrchestrationSettingsForm").CardOrchestrationSettingsPayload = {
    settings: {
      key: "card_orchestration",
      version: 1,
      policy: {
        enabled: false,
        candidates: [
          { agentId: "roselin", nodeId: "sample-node", modelPreset: "sample-sol", minimumRemainingPercent: 15 },
        ],
        usageMaxAgeMs: 300000,
        sessionFolderId: null,
        systemFolderParentId: null,
      },
      updatedAt: now,
      updatedBy: "sample",
    },
    status: { state: "idle", reason: null },
  };
  let jobs: RecurringJob[] = [
    {
      job_id: "sample-job",
      name: "검수 반복 작업",
      prompt: "샘플을 점검합니다.",
      timezone: "Asia/Seoul",
      schedule_kind: "recurring",
      run_at: null,
      schedule_expressions: ["0 9 * * *"],
      node_id: "sample-node",
      agent_id: "roselin",
      model_preset: "sample-sol",
      folderId: dialoguesFolders[0]!.id,
      enabled: true,
      archived_at: null,
      late_run_window_seconds: 1800,
      next_run_at: now,
      version: 1,
      created_at: now,
      updated_at: now,
    },
  ];
  const requests: Array<{ path: string; method: string }> = [];
  const mutations: string[] = [];
  const record = (name: string) => {
    mutations.push(name);
  };
  const recurring: ConfigModalApi["recurring"] = {
    listRecurringJobs: async () => structuredClone(jobs),
    listRecurringJobRuns: async () => [],
    createRecurringJob: async (input) => {
      const job = { ...jobs[0]!, ...input, job_id: crypto.randomUUID(), version: 1, archived_at: null };
      jobs.push(job);
      record("반복 작업 생성");
      return job;
    },
    updateRecurringJob: async (id, input) => {
      const job = jobs.find((j) => j.job_id === id)!;
      Object.assign(job, input, { version: job.version + 1 });
      record("반복 작업 저장");
      return { ...job };
    },
    archiveRecurringJob: async (id) => {
      const job = jobs.find((j) => j.job_id === id)!;
      job.archived_at = now;
      record("반복 작업 보관");
      return { ...job };
    },
    previewRecurringSchedule: async (input) => ({
      ...input,
      scheduleExpressions: input.schedule_expressions,
      nextRuns: [now],
    }),
    runRecurringJob: async (id) => {
      record("반복 작업 실행");
      return {
        run_id: crypto.randomUUID(),
        job_id: id,
        trigger: "manual",
        scheduled_for: null,
        session_id: "sample-session",
        state: "completed",
        reason_code: null,
        reason_message: null,
        job_snapshot: {},
        created_at: now,
        started_at: now,
        finished_at: now,
        updated_at: now,
      } satisfies RecurringJobRun;
    },
  };
  const ownedAgents = createOwnedAgentsFixture(new URLSearchParams(window.location.search).get('ownedState') ?? 'normal');
  const sample = new URLSearchParams(window.location.search).get("sample");
  const persistentState = new URLSearchParams(window.location.search).get("persistentState") ?? (
    sample === "persistent-settings-window-saving" ? "display-save-delayed"
      : sample === "persistent-settings-window-failure" ? "display-save-failure"
        : "normal"
  );
  const persistentSessions = createPersistentSessionsFixture({
    scenario: persistentState,
    nodeId: "sample-node",
    folderId: dialoguesFolders[0]!.id,
  });
  const persistentStoryState = new URLSearchParams(window.location.search).get("persistentStoryState") ?? "full";
  let persistentStoryRequestCount = 0;
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input), "https://sample.invalid");
    const path = url.pathname;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    requests.push({ path, method });
    if (method !== "GET") record(`${method} ${path}`);
    if (path.startsWith('/api/owned-agents')) return ownedAgents(input, init);
    if (path.startsWith("/api/persistent-sessions")) return persistentSessions(input, init);
    if (method === "GET" && /^\/api\/sessions\/[^/]+\/story$/.test(path) && sample?.startsWith("persistent-settings-window")) {
      persistentStoryRequestCount += 1;
      if (persistentStoryState === "loading") {
        const signal = init?.signal;
        return await new Promise<Response>((_resolve, reject) => {
          if (signal?.aborted) {
            reject(new DOMException("The operation was aborted.", "AbortError"));
            return;
          }
          signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")), { once: true });
        });
      }
      // React StrictMode replays the initial loading effect; both initial attempts fail before the explicit retry succeeds.
      if (persistentStoryState === "failure" || (persistentStoryState === "retry" && persistentStoryRequestCount <= 2)) {
        return new Response(JSON.stringify({ error: "sample story unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      const story = persistentStoryState === "empty"
        ? persistentSettingsEmptyStory
        : persistentStoryState === "summaries-only"
          ? persistentSettingsSummariesOnly
          : persistentSettingsStory;
      return new Response(JSON.stringify(story), { headers: { "content-type": "application/json" } });
    }
    let value: unknown;
    if (path === "/cogito/briefs") value = {status:"ok",node_count:1,nodes:[{node_id:"sample-node",status:"ok",data:{status:"ok"}}]};
    else if (path.startsWith("/api/nodes/") && path.endsWith("/model-presets")) value = { model_presets: persistentSettingsModelPresets };
    else if (path.startsWith("/api/sessions/") && path.endsWith("/timeline")) {
      const messages = sample?.startsWith("persistent-settings-window") ? persistentSettingsTimeline : [];
      const eventTypes = url.searchParams.get("event_types")?.split(",");
      const filtered = eventTypes ? messages.filter((message) => eventTypes.includes(message.event_type)) : messages;
      value = { messages: filtered.slice(0, Number(url.searchParams.get("limit") ?? filtered.length)), next_cursor: null };
    }
    else if (path === "/api/config/settings") {
      if (method === "PUT") configValue = body.changes?.sample ?? configValue;
      value =
        method === "GET"
          ? {
              categories: [
                {
                  name: "runtime",
                  label: "실행 설정",
                  fields: [
                    {
                      key: "sample",
                      field_name: "sample",
                      label: "검수 값",
                      description: "이 페이지에서만 저장합니다.",
                      value: configValue,
                      value_type: "str",
                      hot_reloadable: true,
                      read_only: false,
                      sensitive: false,
                    },
                  ],
                },
              ],
            }
          : { applied: Object.keys(body.changes ?? {}), restart_required: [], errors: [] };
    } else if (path === "/api/admin/users" || path.startsWith("/api/admin/users/")) {
      if (method === "POST") users.push({ ...body, createdAt: now, createdBy: "sample" });
      if (method === "PATCH")
        users = users.map((user) =>
          user.email === decodeURIComponent(path.split("/").pop()!) ? { ...user, ...body } : user,
        );
      if (method === "DELETE")
        users = users.filter((user) => user.email !== decodeURIComponent(path.split("/").pop()!));
      value = { users, folders: dialoguesFolders };
    } else if (path.startsWith("/api/admin/settings/") && path.includes("-r2")) {
      if (path.endsWith("/check")) value = { message: "샘플 연결을 확인했습니다." };
      else {
        if (method === "PUT")
          storage = {
            ...storage,
            ...body,
            secretAccessKeyConfigured: body.secretAccessKey === "" ? false : true,
            version: storage.version + 1,
          };
        value = storage;
      }
    } else if (path === "/api/admin/settings/session-review-policy") {
      if (method === "PUT") policy = { ...policy, sourceAllowlist: body.sourceAllowlist, version: policy.version + 1 };
      value = {
        policy,
        conditionalRules: [],
        sourceCatalog: [{ source: "agent", label: "에이전트", description: "위임 요청", automatic: false }],
      };
    } else if (path === "/api/settings/card-dispatch") {
      if (method === "PUT")
        dispatch = { ...dispatch, nodeConcurrency: body.nodeConcurrency, version: dispatch.version + 1 };
      value = { settings: dispatch };
    } else if (path === "/api/settings/card-orchestration") {
      if (method === "PUT")
        orchestration = {
          ...orchestration,
          settings: { ...orchestration.settings, policy: body.policy, version: orchestration.settings.version + 1 },
        };
      value = orchestration;
    } else if (path === "/api/agent-profiles") value = { profiles: [profile] };
    else if (path.startsWith("/api/agent-profiles/")) {
      if (method !== "GET") profile = { ...profile, ...body, version: profile.version + 1 };
      value = profile;
    } else if (path === "/api/context-bundles") value = { bundles };
    else if (path.startsWith("/api/context-bundles/")) {
      const id = decodeURIComponent(path.split("/").pop()!);
      const existing = bundles.find((b) => b.bundle_id === id);
      if (method === "DELETE") bundles = bundles.filter((b) => b.bundle_id !== id);
      if (method === "PUT") {
        const next = {
          bundle_id: id,
          ...body,
          version: Number(existing?.version ?? 0) + 1,
          created_at: now,
          updated_at: now,
        };
        bundles = [...bundles.filter((b) => b.bundle_id !== id), next];
        value = next;
      } else value = existing ?? {};
    } else if (path.includes("/agents/context-preview"))
      value = {
        manifest: { sources: [{ id: "sample", label: "샘플 컨텍스트", status: "ok", chars: 100, token_estimate: 25 }] },
      };
    else if (path.endsWith("/agents")) value = { agents: dialoguesAssignment.agents };
    else if (path.includes("/claude-auth/"))
      value = path.endsWith("/headless/start")
        ? { authUrl: "/dialogues#sample-auth" }
        : path.endsWith("/profile")
          ? { account: { email: "sample@example.invalid", display_name: "검수 계정", has_claude_max: true } }
          : { has_token: true };
    else if (path.endsWith("/provider-usage")) value = { providers: [] };
    else if (path === "/api/ui-events") value = { events: [] };
    else if (path === "/api/ui-events/installs") value = { installs: [] };
    else if (path === "/api/atom/nodes" || path.startsWith("/api/atom/nodes/"))
      value = {
        children: [
          { id: "sample-atom", card_id: "sample-atom-card", card: { title: "검수 지식", card_type: "knowledge" } },
        ],
      };
    else if (path.startsWith("/api/pages/")) {
      const temp_id_mapping: Record<string, string> = {};
      for (const op of body.operations ?? []) {
        if (op.op === "create_block") {
          const id = crypto.randomUUID();
          temp_id_mapping[op.temp_id] = id;
          blocks.push({
            id,
            page_id: page.id,
            parent_id: op.parent_id,
            position_key: "a",
            block_type: op.block_type,
            text: op.text,
            properties: op.properties,
            collapsed: op.collapsed,
          });
        } else if (op.op === "delete_block_subtree") blocks = blocks.filter((block) => block.id !== op.block_id);
        else {
          const block = blocks.find((block) => block.id === op.block_id);
          if (block)
            Object.assign(block, {
              text: op.text ?? block.text,
              block_type: op.block_type ?? block.block_type,
              properties: op.properties ?? block.properties,
            });
        }
      }
      if (method !== "GET") page.version += 1;
      value = { page, blocks, state_vector: "", operation: { id: "sample-op" }, temp_id_mapping };
    } else if (path.startsWith("/api/markdown-documents/")) {
      if (method === "PUT") document = { ...document, ...body, version: document.version + 1 };
      value = document;
    } else if (path.includes("search")) value = { results: [], navigation_results: [], session_results: [] };
    else throw new Error(`샘플 API가 정의되지 않았습니다: ${method} ${path}`);
    return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  };
  const cards: ConfigModalApi["cards"] = async <T>(path: string, method = "GET", body?: unknown) =>
    (await (await request(path, { method, body: body === undefined ? undefined : JSON.stringify(body) })).json()) as T;
  const config: ConfigModalApi = {
    nodes: new Map([
      [
        "sample-node",
        {
          nodeId: "sample-node",
          host: "sample.invalid",
          port: 0,
          status: "connected",
          capabilities: {},
          connectedAt: 0,
          sessionCount: 1,
        },
      ],
    ]),
    request,
    recurring,
    cards,
    orchestration: {
      read: async () => orchestration,
      write: async (input) => {
        record("카드 배정 정책 저장");
        orchestration = {
          ...orchestration,
          settings: { ...orchestration.settings, policy: input.policy, version: orchestration.settings.version + 1 },
        };
        return orchestration;
      },
    },
    assignment: dialoguesAssignment,
  };
  return { request, config, record, requests, mutations, local };
}
