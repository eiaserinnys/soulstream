import type { ConfigModalApi } from "../components/ConfigModal";
import { createOwnedAgentsFixture } from "./owned-agents-fixture";
import type { RecurringJob, RecurringJobRun } from "../lib/recurring-jobs";
import type { AssignmentData } from "./AgentNodeAssignmentFields";
import { reviewFolder, reviewFolders } from "./components-review-fixtures";
const now = "2026-10-03T00:00:00Z";
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
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input), "https://sample.invalid");
    const path = url.pathname;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    requests.push({ path, method });
    if (method !== "GET") record(`${method} ${path}`);
    if (path.startsWith('/api/owned-agents')) return ownedAgents(input, init);
    let value: unknown;
    if (path === "/cogito/briefs") value = {status:"ok",node_count:1,nodes:[{node_id:"sample-node",status:"ok",data:{status:"ok"}}]};
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
