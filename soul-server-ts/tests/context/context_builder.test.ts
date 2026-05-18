/**
 * ExecutionContextBuilder 단위 회귀 — Python `service/execution_context_builder.py` 정본 정합.
 */

import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentRegistry, type AgentProfile } from "../../src/agent_registry.js";
import type { SessionDB } from "../../src/db/session_db.js";
import {
  ExecutionContextBuilder,
  composeFirstTurnPrompt,
} from "../../src/context/context_builder.js";
import type { Task } from "../../src/task/task_models.js";

const silentLogger = pino({ level: "silent" });

const codexAgent: AgentProfile = {
  id: "codex-default",
  name: "Codex Default",
  backend: "codex",
  workspace_dir: "/agent/default",
};

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "sess-1",
    prompt: "user prompt",
    status: "running",
    profileId: "codex-default",
    createdAt: new Date(),
    lastEventId: 0,
    lastReadEventId: 0,
    interventionQueue: [],
    ...overrides,
  };
}

function makeBuilder(
  dbOverrides: Partial<SessionDB> = {},
  registry?: AgentRegistry,
  atomEnabled = false,
): ExecutionContextBuilder {
  const getSession = vi.fn().mockResolvedValue(null);
  const getFolderById = vi.fn().mockResolvedValue(null);
  const db = { getSession, getFolderById, ...dbOverrides } as unknown as SessionDB;
  return new ExecutionContextBuilder(
    db,
    registry ?? new AgentRegistry([codexAgent]),
    {
      nodeId: "node-A",
      atom: {
        enabled: atomEnabled,
        serverUrl: atomEnabled ? "https://atom.test" : "",
        apiKey: atomEnabled ? "k" : "",
      },
    },
    silentLogger,
  );
}

describe("ExecutionContextBuilder.build — 기본 흐름", () => {
  it("folder 없음 → effectiveSystemPrompt undefined, soulstream_item만 combinedContextItems", async () => {
    const cb = makeBuilder();
    const ctx = await cb.build(makeTask(), codexAgent);
    expect(ctx.effectiveSystemPrompt).toBeUndefined();
    expect(ctx.combinedContextItems).toHaveLength(1);
    expect(ctx.combinedContextItems[0].key).toBe("soulstream_session");
  });

  it("folder.folderPrompt 있음 → effectiveSystemPrompt에 prepend", async () => {
    const getSession = vi.fn().mockResolvedValue({ folder_id: "f-1" });
    const getFolderById = vi.fn().mockResolvedValue({
      id: "f-1",
      name: "✨ 소울스트림",
      sort_order: 0,
      settings: { folderPrompt: "폴더 페르소나 지시문" },
    });
    const cb = makeBuilder({ getSession, getFolderById } as Partial<SessionDB>);
    const ctx = await cb.build(makeTask(), codexAgent);
    expect(ctx.effectiveSystemPrompt).toBe("폴더 페르소나 지시문");
    expect(ctx.folderName).toBe("✨ 소울스트림");
  });

  it("folder.folderPrompt + task.systemPrompt → 둘 다 \\n\\n으로 연결", async () => {
    const getSession = vi.fn().mockResolvedValue({ folder_id: "f-1" });
    const getFolderById = vi.fn().mockResolvedValue({
      id: "f-1",
      name: "n",
      sort_order: 0,
      settings: { folderPrompt: "폴더" },
    });
    const cb = makeBuilder({ getSession, getFolderById } as Partial<SessionDB>);
    const ctx = await cb.build(
      makeTask({ systemPrompt: "task system" }),
      codexAgent,
    );
    expect(ctx.effectiveSystemPrompt).toBe("폴더\n\ntask system");
  });

  it("folderPrompt 없고 task.systemPrompt만 있음 → 그대로 반환", async () => {
    const cb = makeBuilder();
    const ctx = await cb.build(
      makeTask({ systemPrompt: "task only" }),
      codexAgent,
    );
    expect(ctx.effectiveSystemPrompt).toBe("task only");
  });

  it("profile.workspace_dir → workingDir 반환, soulstream_item.workspace_dir에 박힘", async () => {
    const profile: AgentProfile = {
      id: "codex-folder",
      name: "Codex Folder",
      backend: "codex",
      workspace_dir: "/profile/path",
    };
    const cb = makeBuilder({}, new AgentRegistry([profile]));
    const ctx = await cb.build(
      makeTask({ profileId: "codex-folder" }),
      profile,
    );
    expect(ctx.workingDir).toBe("/profile/path");
    const item = ctx.combinedContextItems[0];
    expect((item.content as Record<string, unknown>).workspace_dir).toBe("/profile/path");
  });

  it("profile 미발견 → agent.workspace_dir로 폴백", async () => {
    const cb = makeBuilder({}, new AgentRegistry([]));
    const ctx = await cb.build(makeTask({ profileId: "missing" }), codexAgent);
    expect(ctx.workingDir).toBeUndefined();
    const item = ctx.combinedContextItems[0];
    expect((item.content as Record<string, unknown>).workspace_dir).toBe("/agent/default");
  });

  it("callerInfo 운반 → soulstream_item.content.caller_info (R-2 차단)", async () => {
    const cb = makeBuilder();
    const ctx = await cb.build(
      makeTask({ callerInfo: { source: "slack", display_name: "Alice" } }),
      codexAgent,
    );
    const content = ctx.combinedContextItems[0].content as Record<string, unknown>;
    expect(content.caller_info).toEqual({ source: "slack", display_name: "Alice" });
  });

  it("getSession throw → graceful, folder 없는 흐름과 동일", async () => {
    const getSession = vi.fn().mockRejectedValue(new Error("db down"));
    const cb = makeBuilder({ getSession } as Partial<SessionDB>);
    const ctx = await cb.build(makeTask(), codexAgent);
    expect(ctx.effectiveSystemPrompt).toBeUndefined();
    expect(ctx.combinedContextItems).toHaveLength(1);  // soulstream_item만
  });
});

describe("ExecutionContextBuilder.build — atom_context fetch", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = vi.fn() as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("folder.settings.atomContextNode 있고 atom 활성 → atom_context item 추가", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ markdown: "## atom node\nbody" }), { status: 200 }),
    );
    const getSession = vi.fn().mockResolvedValue({ folder_id: "f-1" });
    const getFolderById = vi.fn().mockResolvedValue({
      id: "f-1",
      name: "f",
      sort_order: 0,
      settings: {
        atomContextNode: { nodeId: "11111111-2222-3333-4444-555555555555", depth: 2 },
      },
    });
    const cb = makeBuilder({ getSession, getFolderById } as Partial<SessionDB>, undefined, true);
    const ctx = await cb.build(makeTask(), codexAgent);
    expect(ctx.combinedContextItems).toHaveLength(2);  // soulstream + atom
    expect(ctx.combinedContextItems[1].key).toBe("atom_context");
    expect(ctx.combinedContextItems[1].content).toContain("## atom node");
  });

  it("atom 호출 실패 → atom_context 미포함, turn 진행 계속 (graceful)", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error("network"));
    const getSession = vi.fn().mockResolvedValue({ folder_id: "f-1" });
    const getFolderById = vi.fn().mockResolvedValue({
      id: "f-1",
      name: "f",
      sort_order: 0,
      settings: {
        atomContextNode: { nodeId: "11111111-2222-3333-4444-555555555555" },
      },
    });
    const cb = makeBuilder({ getSession, getFolderById } as Partial<SessionDB>, undefined, true);
    const ctx = await cb.build(makeTask(), codexAgent);
    expect(ctx.combinedContextItems).toHaveLength(1);  // soulstream만
  });

  it("atomContextNode 설정 없음 → atom 호출 자체 안 함", async () => {
    const fetchSpy = vi.mocked(globalThis.fetch);
    const getSession = vi.fn().mockResolvedValue({ folder_id: "f-1" });
    const getFolderById = vi.fn().mockResolvedValue({
      id: "f-1",
      name: "f",
      sort_order: 0,
      settings: { folderPrompt: "x" },
    });
    const cb = makeBuilder({ getSession, getFolderById } as Partial<SessionDB>, undefined, true);
    await cb.build(makeTask(), codexAgent);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("atom env 비활성 + atomContextNode 있음 → atom 호출 안 함", async () => {
    const fetchSpy = vi.mocked(globalThis.fetch);
    const getSession = vi.fn().mockResolvedValue({ folder_id: "f-1" });
    const getFolderById = vi.fn().mockResolvedValue({
      id: "f-1",
      name: "f",
      sort_order: 0,
      settings: {
        atomContextNode: { nodeId: "11111111-2222-3333-4444-555555555555" },
      },
    });
    const cb = makeBuilder({ getSession, getFolderById } as Partial<SessionDB>, undefined, false);
    const ctx = await cb.build(makeTask(), codexAgent);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(ctx.combinedContextItems).toHaveLength(1);
  });
});

describe("composeFirstTurnPrompt — 합성 알고리즘", () => {
  it("systemPrompt + context + userPrompt 합성", () => {
    const out = composeFirstTurnPrompt({
      effectiveSystemPrompt: "SP",
      combinedContextItems: [{ key: "ctx", content: "value" }],
      assembledPrompt: "USER",
    });
    expect(out).toBe(
      "SP\n\n<context>\n<ctx>\nvalue\n</ctx>\n</context>\n\nUSER",
    );
  });

  it("systemPrompt 없음 → context + userPrompt", () => {
    const out = composeFirstTurnPrompt({
      combinedContextItems: [{ key: "c", content: "v" }],
      assembledPrompt: "U",
    });
    expect(out).toBe("<context>\n<c>\nv\n</c>\n</context>\n\nU");
  });

  it("context 없음 → systemPrompt + userPrompt", () => {
    const out = composeFirstTurnPrompt({
      effectiveSystemPrompt: "SP",
      combinedContextItems: [],
      assembledPrompt: "U",
    });
    expect(out).toBe("SP\n\nU");
  });

  it("systemPrompt·context 둘 다 없음 → userPrompt만", () => {
    const out = composeFirstTurnPrompt({
      combinedContextItems: [],
      assembledPrompt: "U",
    });
    expect(out).toBe("U");
  });
});

// F1 (PR fix/soul-server-ts-chat-sse-python-parity): auto-resume 시 user_message.context로 박을
// 최소 context_items. Python `_assemble_context` resume 분기(combined_context_items = [soulstream_item])
// 정합. TaskManager가 `ResumeContextProvider` interface로 호출하여 wire에 forward한다.
describe("ExecutionContextBuilder.buildResumeContextItems (F1)", () => {
  it("folder 없음 → soulstream_item 1개 반환, folder=(unassigned)", async () => {
    const cb = makeBuilder();
    const items = await cb.buildResumeContextItems(makeTask({ codexThreadId: "thr-1" }));
    expect(items).toHaveLength(1);
    expect(items[0].key).toBe("soulstream_session");
    const content = items[0].content as Record<string, unknown>;
    expect(content.folder).toBe("(unassigned)");
    expect(content.claude_session_id).toBe("thr-1");  // codexThreadId 운반
    expect(content.agent_session_id).toBe("sess-1");
  });

  it("folder lookup 성공 → soulstream_item.content.folder = folder.name", async () => {
    const getSession = vi.fn().mockResolvedValue({ folder_id: "f-9" });
    const getFolderById = vi.fn().mockResolvedValue({
      id: "f-9",
      name: "✨ 소울스트림",
      sort_order: 0,
      settings: { folderPrompt: "건드리지 않음" },
    });
    const cb = makeBuilder({ getSession, getFolderById } as Partial<SessionDB>);
    const items = await cb.buildResumeContextItems(makeTask());
    expect(items).toHaveLength(1);
    const content = items[0].content as Record<string, unknown>;
    expect(content.folder).toBe("✨ 소울스트림");
  });

  it("folder lookup throw → graceful, folder=(unassigned)로 진행", async () => {
    const getSession = vi.fn().mockRejectedValue(new Error("db down"));
    const cb = makeBuilder({ getSession } as Partial<SessionDB>);
    const items = await cb.buildResumeContextItems(makeTask());
    expect(items).toHaveLength(1);
    const content = items[0].content as Record<string, unknown>;
    expect(content.folder).toBe("(unassigned)");
  });

  it("folder_id 있지만 folder row 미발견 → folder=(unassigned)", async () => {
    const getSession = vi.fn().mockResolvedValue({ folder_id: "f-missing" });
    const getFolderById = vi.fn().mockResolvedValue(null);
    const cb = makeBuilder({ getSession, getFolderById } as Partial<SessionDB>);
    const items = await cb.buildResumeContextItems(makeTask());
    expect(items).toHaveLength(1);
    const content = items[0].content as Record<string, unknown>;
    expect(content.folder).toBe("(unassigned)");
  });

  it("profile registry 발견 → workspace_dir=profile.workspace_dir로 박힘", async () => {
    const profile: AgentProfile = {
      id: "codex-resume",
      name: "Codex Resume",
      backend: "codex",
      workspace_dir: "/agent/resume-path",
    };
    const cb = makeBuilder({}, new AgentRegistry([profile]));
    const items = await cb.buildResumeContextItems(makeTask({ profileId: "codex-resume" }));
    const content = items[0].content as Record<string, unknown>;
    expect(content.workspace_dir).toBe("/agent/resume-path");
  });

  it("profile registry 미발견 → workspace_dir=\"\" (graceful)", async () => {
    const cb = makeBuilder({}, new AgentRegistry([]));
    const items = await cb.buildResumeContextItems(makeTask({ profileId: "missing" }));
    const content = items[0].content as Record<string, unknown>;
    expect(content.workspace_dir).toBe("");
  });

  it("task.callerInfo → soulstream_item.content.caller_info 운반 (R-2 차단, resume 경로)", async () => {
    const cb = makeBuilder();
    const items = await cb.buildResumeContextItems(
      makeTask({ callerInfo: { source: "slack", display_name: "Alice" } }),
    );
    const content = items[0].content as Record<string, unknown>;
    expect(content.caller_info).toEqual({ source: "slack", display_name: "Alice" });
  });

  it("folder_prompt·atomContextNode 설정이 있어도 *재주입 안 함* (resume 분기 정합)", async () => {
    // folderPrompt와 atomContextNode 둘 다 설정된 folder에 대해 호출.
    // Python `_resolve_folder` L100, `_fetch_atom_context` L111 가드 정합 — resume 시 둘 다 skip.
    // buildResumeContextItems은 folder_name만 lookup하므로 folder_prompt/atom_context는 반환물에 없음.
    const getSession = vi.fn().mockResolvedValue({ folder_id: "f-rich" });
    const getFolderById = vi.fn().mockResolvedValue({
      id: "f-rich",
      name: "✨ 풀세트",
      sort_order: 0,
      settings: {
        folderPrompt: "이 프롬프트는 resume에 적용되지 않아야 함",
        atomContextNode: { nodeId: "00000000-0000-0000-0000-000000000000", depth: 3 },
      },
    });
    const cb = makeBuilder(
      { getSession, getFolderById } as Partial<SessionDB>,
      undefined,
      true,  // atom 활성
    );
    const items = await cb.buildResumeContextItems(makeTask());
    // soulstream_item만, atom_context 항목 없음
    expect(items).toHaveLength(1);
    expect(items[0].key).toBe("soulstream_session");
    // folder_name은 운반되지만 folder_prompt는 무관
    const content = items[0].content as Record<string, unknown>;
    expect(content.folder).toBe("✨ 풀세트");
  });
});
