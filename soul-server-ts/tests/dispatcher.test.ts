import { describe, expect, it, vi } from "vitest";
import pino from "pino";

import { AgentRegistry, type AgentProfile } from "../src/agent_registry.js";
import { AttachmentError, type FileManager, type SaveResult } from "../src/service/file_manager.js";
import { CommandDispatcher } from "../src/upstream/dispatcher.js";
import type { TaskExecutor } from "../src/task/task_executor.js";
import type { TaskManager } from "../src/task/task_manager.js";
import type { Task } from "../src/task/task_models.js";

const silentLogger = pino({ level: "silent" });

const codexAgent: AgentProfile = {
  id: "codex-default",
  name: "Codex Default",
  backend: "codex",
  workspace_dir: "/tmp/codex-default",
};

/** 기본 FileManager mock — 정상 케이스에서 사용 */
function makeDefaultFileManager(overrides: Partial<FileManager> = {}): FileManager {
  const defaultSaveResult: SaveResult = {
    path: "/tmp/incoming/sess-1/1000_test.png",
    filename: "1000_test.png",
    size: 100,
    content_type: "image/png",
  };
  return {
    getSessionDir: vi.fn(async (id) => `/tmp/incoming/${id}`),
    isUnderBase: vi.fn(async () => true),
    validateFile: vi.fn(),
    saveFileForSession: vi.fn(async () => defaultSaveResult),
    cleanupSession: vi.fn(async () => 3),
    cleanupOldFiles: vi.fn(async () => 0),
    getStats: vi.fn(async () => ({
      base_dir: "/tmp/incoming",
      session_count: 0,
      total_files: 0,
      total_size_mb: 0,
      max_file_size_mb: 8,
    })),
    ...overrides,
  } as unknown as FileManager;
}

function createDispatcher(opts: {
  nodeId?: string;
  agents?: AgentProfile[];
  runningTasks?: number;
  taskManager?: Partial<TaskManager>;
  taskExecutor?: Partial<TaskExecutor>;
  fileManager?: Partial<FileManager>;
} = {}) {
  const sent: unknown[] = [];
  const send = vi.fn(async (data: unknown) => {
    sent.push(data);
  });
  const registry = new AgentRegistry(opts.agents ?? [codexAgent]);

  const createdTasks: Task[] = [];
  const runningTasks: Task[] = Array(opts.runningTasks ?? 0)
    .fill(null)
    .map((_, i) => ({
      agentSessionId: `running-${i}`,
      prompt: "",
      status: "running" as const,
      createdAt: new Date(),
      lastEventId: 0,
      lastReadEventId: 0,
      interventionQueue: [],
    }));

  const defaultTaskManager: Partial<TaskManager> = {
    createTask: vi.fn(async (params) => {
      const task: Task = {
        agentSessionId: params.agentSessionId,
        prompt: params.prompt,
        status: "running",
        profileId: params.profileId,
        callerSessionId: params.callerSessionId ?? undefined,
        callerInfo: params.callerInfo,
        model: params.model,
        createdAt: new Date(),
        lastEventId: 0,
        lastReadEventId: 0,
        interventionQueue: [],
      };
      createdTasks.push(task);
      return task;
    }),
    listTasks: vi.fn(() => runningTasks),
    addIntervention: vi.fn(),
  };

  const defaultExecutor: Partial<TaskExecutor> = {
    startExecution: vi.fn(),
  };

  const tm = { ...defaultTaskManager, ...opts.taskManager } as TaskManager;
  const te = { ...defaultExecutor, ...opts.taskExecutor } as TaskExecutor;
  const fm = makeDefaultFileManager(opts.fileManager ?? {});

  const dispatcher = new CommandDispatcher(
    send,
    silentLogger,
    opts.nodeId ?? "eias-shopping-ts",
    registry,
    tm,
    te,
    fm,
  );
  return { dispatcher, sent, send, registry, tm, te, createdTasks, fm };
}

describe("CommandDispatcher.health_check", () => {
  it("agentRegistry.length를 max_concurrent로, running task 개수를 active로 박음", async () => {
    const { dispatcher, sent } = createDispatcher({ runningTasks: 1 });
    await dispatcher.dispatch({ type: "health_check", requestId: "req-1" });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: "health_status",
      runners: { max_concurrent: 1, active: 1 },
      node_id: "eias-shopping-ts",
      requestId: "req-1",
    });
  });

  it("requestId 없으면 빈 문자열 fallback", async () => {
    const { dispatcher, sent } = createDispatcher();
    await dispatcher.dispatch({ type: "health_check" });
    expect((sent[0] as { requestId: string }).requestId).toBe("");
  });

  it("snake_case request_id도 camel로 회신", async () => {
    const { dispatcher, sent } = createDispatcher();
    await dispatcher.dispatch({ type: "health_check", request_id: "snake-1" });
    expect((sent[0] as { requestId: string }).requestId).toBe("snake-1");
  });
});

describe("CommandDispatcher.create_session", () => {
  it("정상 흐름: task_manager.createTask + task_executor.startExecution + session_created ACK", async () => {
    const { dispatcher, sent, tm, te, createdTasks } = createDispatcher();
    await dispatcher.dispatch({
      type: "create_session",
      agentSessionId: "sess-1",
      prompt: "hi",
      profile: "codex-default",
      requestId: "cs-1",
    });

    expect(tm.createTask).toHaveBeenCalledTimes(1);
    expect(te.startExecution).toHaveBeenCalledTimes(1);
    expect(createdTasks).toHaveLength(1);
    expect(createdTasks[0].agentSessionId).toBe("sess-1");

    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: "session_created",
      agentSessionId: "sess-1",
      requestId: "cs-1",
    });
  });

  it("requestId 없으면 session_created ACK 발행 안 함 (atom c13f7826)", async () => {
    const { dispatcher, sent } = createDispatcher();
    await dispatcher.dispatch({
      type: "create_session",
      agentSessionId: "sess-1",
      prompt: "hi",
      profile: "codex-default",
    });
    expect(sent).toHaveLength(0);
  });

  it("agentSessionId 또는 prompt 부재 시 error", async () => {
    const { dispatcher, sent, tm } = createDispatcher();
    await dispatcher.dispatch({
      type: "create_session",
      prompt: "hi",
      profile: "codex-default",
      requestId: "r1",
    });
    expect(sent[0]).toMatchObject({ type: "error", command_type: "create_session" });
    expect(tm.createTask).not.toHaveBeenCalled();
  });

  it("profile 부재 시 error", async () => {
    const { dispatcher, sent, tm } = createDispatcher();
    await dispatcher.dispatch({
      type: "create_session",
      agentSessionId: "sess-1",
      prompt: "hi",
      requestId: "r1",
    });
    expect((sent[0] as { message: string }).message).toContain("profile");
    expect(tm.createTask).not.toHaveBeenCalled();
  });

  it("Unknown agent profile → error", async () => {
    const { dispatcher, sent, tm } = createDispatcher();
    await dispatcher.dispatch({
      type: "create_session",
      agentSessionId: "sess-1",
      prompt: "hi",
      profile: "nonexistent",
      requestId: "r1",
    });
    expect((sent[0] as { message: string }).message).toContain("Unknown agent profile");
    expect(tm.createTask).not.toHaveBeenCalled();
  });

  it("createTask가 throw하면 error 응답 (Handler error wrap)", async () => {
    const { dispatcher, sent } = createDispatcher({
      taskManager: {
        createTask: vi.fn().mockRejectedValue(new Error("db down")),
      },
    });
    await dispatcher.dispatch({
      type: "create_session",
      agentSessionId: "sess-1",
      prompt: "hi",
      profile: "codex-default",
      requestId: "r1",
    });
    expect((sent[0] as { type: string }).type).toBe("error");
    expect((sent[0] as { message: string }).message).toContain("db down");
  });
});

describe("CommandDispatcher.intervene (B-4)", () => {
  it("running task에 intervene → addIntervention queued → intervene_ack(queued, queuePosition)", async () => {
    const addIntervention = vi.fn(async () => ({ queued: true, queuePosition: 2 }));
    const { dispatcher, sent } = createDispatcher({
      taskManager: { addIntervention } as Partial<TaskManager>,
    });
    await dispatcher.dispatch({
      type: "intervene",
      agentSessionId: "sess-1",
      text: "hello",
      user: "alice",
      requestId: "i1",
    });
    expect(addIntervention).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSessionId: "sess-1",
        text: "hello",
        user: "alice",
      }),
      expect.any(Function),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "intervene_ack",
      requestId: "i1",
      status: "ok",
      outcome: "queued",
      queuePosition: 2,
    });
  });

  it("completed task에 intervene → auto-resume → intervene_ack(auto_resumed) + startExecution 호출", async () => {
    // addIntervention이 onResume 콜백 호출을 흉내내어 dispatcher의 startExecution 분기 검증.
    const startExecution = vi.fn();
    const fakeAgent: AgentProfile = {
      id: "codex-default",
      name: "Codex Default",
      backend: "codex",
      workspace_dir: "/tmp/codex-default",
    };
    const fakeTask: Task = {
      agentSessionId: "sess-2",
      prompt: "prior",
      status: "running",
      profileId: fakeAgent.id,
      createdAt: new Date(),
      lastEventId: 0,
      lastReadEventId: 0,
      interventionQueue: [],
    };
    const addIntervention = vi.fn(async (_params, onResume) => {
      onResume(fakeTask);
      return { autoResumed: true };
    });
    const { dispatcher, sent } = createDispatcher({
      agents: [fakeAgent],
      taskManager: { addIntervention } as Partial<TaskManager>,
      taskExecutor: { startExecution } as Partial<TaskExecutor>,
    });
    await dispatcher.dispatch({
      type: "intervene",
      agentSessionId: "sess-2",
      text: "resume me",
      requestId: "i2",
    });
    expect(startExecution).toHaveBeenCalledWith(fakeTask, fakeAgent);
    expect(sent[0]).toMatchObject({
      type: "intervene_ack",
      requestId: "i2",
      status: "ok",
      outcome: "auto_resumed",
      agentSessionId: "sess-2",
    });
  });

  it("미존재 task에 intervene → addIntervention throw → error wire", async () => {
    const addIntervention = vi.fn(async () => {
      throw new Error("Task not found: sess-missing");
    });
    const { dispatcher, sent } = createDispatcher({
      taskManager: { addIntervention } as Partial<TaskManager>,
    });
    await dispatcher.dispatch({
      type: "intervene",
      agentSessionId: "sess-missing",
      text: "x",
      requestId: "i3",
    });
    expect((sent[0] as { type: string }).type).toBe("error");
    expect((sent[0] as { message: string }).message).toContain("Task not found");
  });

  it("text 누락 시 sendError (addIntervention 호출 안 함)", async () => {
    const addIntervention = vi.fn();
    const { dispatcher, sent } = createDispatcher({
      taskManager: { addIntervention } as Partial<TaskManager>,
    });
    await dispatcher.dispatch({
      type: "intervene",
      agentSessionId: "sess-1",
      requestId: "i4",
    });
    expect(addIntervention).not.toHaveBeenCalled();
    expect((sent[0] as { type: string }).type).toBe("error");
    expect((sent[0] as { message: string }).message).toContain("agentSessionId and text");
  });

  it("requestId 부재 시 ACK 발행 안 함 (atom c13f7826 빈 ACK 금지)", async () => {
    const addIntervention = vi.fn(async () => ({ queued: true, queuePosition: 1 }));
    const { dispatcher, sent } = createDispatcher({
      taskManager: { addIntervention } as Partial<TaskManager>,
    });
    await dispatcher.dispatch({
      type: "intervene",
      agentSessionId: "sess-1",
      text: "x",
    });
    expect(addIntervention).toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });
});

describe("CommandDispatcher.subscribe_events (SSE realtime sync fix)", () => {
  // 사용자 보고: codex 세션의 진행 중 text_delta가 채팅 영역에 즉시 표시되지 않음. REST history는
  // 정상. 분석 캐시 `20260518-1218-codex-sse-realtime-sync.md` 가설 X — subscribe_events 미구현이
  // 간접 차단. dispatcher가 "Not implemented" error 응답을 wire에 보낸 흔적이 라이브 로그에서 6회 확인.
  // Python `_handle_subscribe_events` 정합: relay loop 시작이지만 TS는 broadcaster.emitEventEnvelope이
  // 이미 모든 task event를 emit하므로 NOOP 수락.

  it("subscribe_events → ACK 없이 silent 수락 (error 응답 미발행)", async () => {
    const { dispatcher, sent } = createDispatcher();
    await dispatcher.dispatch({
      type: "subscribe_events",
      agentSessionId: "sess-x",
      subscribeId: "sub-1",
    });
    expect(sent).toHaveLength(0);
  });

  it("subscribe_events에 requestId 있어도 ACK 안 발행 (Python 정본 정합)", async () => {
    const { dispatcher, sent } = createDispatcher();
    await dispatcher.dispatch({
      type: "subscribe_events",
      agentSessionId: "sess-x",
      subscribeId: "sub-1",
      requestId: "req-1",
    });
    // Python `_handle_subscribe_events`도 ACK type emit 안 함 — relay loop만 시작.
    // orch send_subscribe_events는 fire-and-forget이라 ACK 없어도 동작 영향 0.
    expect(sent).toHaveLength(0);
  });

  it("subscribe_events 이후 다른 cmd 흐름에 영향 없음 (handler chain 독립)", async () => {
    const { dispatcher, sent } = createDispatcher();
    await dispatcher.dispatch({ type: "subscribe_events", agentSessionId: "sess-x" });
    await dispatcher.dispatch({ type: "health_check", requestId: "h-1" });
    expect(sent).toHaveLength(1);
    const reply = sent[0] as { type: string };
    expect(reply.type).toBe("health_status");
  });
});

describe("CommandDispatcher unknown command", () => {
  it("respond·list_sessions 등 → Not implemented error (subscribe_events는 별 핸들러)", async () => {
    const { dispatcher, sent } = createDispatcher();
    const commands = ["respond", "list_sessions"];
    for (const type of commands) {
      await dispatcher.dispatch({ type, requestId: `${type}-id` });
    }
    expect(sent).toHaveLength(2);
    for (let i = 0; i < commands.length; i++) {
      const reply = sent[i] as { type: string; message: string; command_type: string };
      expect(reply.type).toBe("error");
      expect(reply.command_type).toBe(commands[i]);
      expect(reply.message).toContain("Not implemented in soul-server-ts");
    }
  });

  it("type이 없는 명령은 무시 (응답 없음)", async () => {
    const { dispatcher, sent } = createDispatcher();
    await dispatcher.dispatch({ requestId: "x" });
    expect(sent).toHaveLength(0);
  });

  it("undefined/null 명령은 무시", async () => {
    const { dispatcher, sent } = createDispatcher();
    await dispatcher.dispatch(undefined);
    await dispatcher.dispatch(null);
    expect(sent).toHaveLength(0);
  });
});

// ─── Attachment 핸들러 테스트 ───────────────────────────────────────────────

describe("CommandDispatcher.upload_attachment", () => {
  const validB64 = Buffer.from("hello world").toString("base64"); // "aGVsbG8gd29ybGQ="

  it("정상 흐름: saveFileForSession 호출 + upload_attachment_result ACK", async () => {
    const { dispatcher, sent, fm } = createDispatcher();
    await dispatcher.dispatch({
      type: "upload_attachment",
      session_id: "sess-1",
      filename: "test.png",
      content_type: "image/png",
      content_b64: validB64,
      requestId: "ua-1",
    });
    expect(fm.saveFileForSession).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
    const msg = sent[0] as Record<string, unknown>;
    expect(msg.type).toBe("upload_attachment_result");
    expect(msg.requestId).toBe("ua-1");
    expect(typeof msg.path).toBe("string");
    expect(typeof msg.size).toBe("number");
  });

  it("requestId 없으면 ACK 발행 안 함 (Python 정합)", async () => {
    const { dispatcher, sent, fm } = createDispatcher();
    await dispatcher.dispatch({
      type: "upload_attachment",
      session_id: "sess-1",
      filename: "test.png",
      content_b64: validB64,
    });
    expect(fm.saveFileForSession).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(0);
  });

  it("content_b64 누락 → INVALID_REQUEST error", async () => {
    const { dispatcher, sent, fm } = createDispatcher();
    await dispatcher.dispatch({
      type: "upload_attachment",
      session_id: "sess-1",
      requestId: "ua-2",
    });
    expect(fm.saveFileForSession).not.toHaveBeenCalled();
    const msg = sent[0] as { type: string; message: string };
    expect(msg.type).toBe("error");
    expect(msg.message).toContain("INVALID_REQUEST");
    expect(msg.message).toContain("content_b64");
  });

  it("session_id 누락 → INVALID_REQUEST error", async () => {
    const { dispatcher, sent, fm } = createDispatcher();
    await dispatcher.dispatch({
      type: "upload_attachment",
      content_b64: validB64,
      requestId: "ua-3",
    });
    expect(fm.saveFileForSession).not.toHaveBeenCalled();
    const msg = sent[0] as { type: string; message: string };
    expect(msg.type).toBe("error");
    expect(msg.message).toContain("INVALID_REQUEST");
    expect(msg.message).toContain("session_id");
  });

  it("AttachmentError(크기·확장자 검증 실패) → INVALID_REQUEST: {message}", async () => {
    const fm = makeDefaultFileManager({
      saveFileForSession: vi.fn(async () => {
        throw new AttachmentError("파일이 너무 큽니다 (10MB > 8MB)");
      }),
    });
    const { dispatcher, sent } = createDispatcher({ fileManager: fm });
    await dispatcher.dispatch({
      type: "upload_attachment",
      session_id: "sess-1",
      filename: "big.png",
      content_b64: validB64,
      requestId: "ua-4",
    });
    const msg = sent[0] as { type: string; message: string };
    expect(msg.type).toBe("error");
    expect(msg.message).toContain("INVALID_REQUEST");
    expect(msg.message).toContain("파일이 너무 큽니다");
  });

  it("invalid base64 문자 → INVALID_REQUEST (Python validate=True 정합)", async () => {
    // Buffer.from("!!!invalid!!!", "base64")는 silently strip하여 디코딩하지만
    // 정규식 사전 검증으로 차단해야 한다.
    const { dispatcher, sent, fm } = createDispatcher();
    await dispatcher.dispatch({
      type: "upload_attachment",
      session_id: "sess-1",
      filename: "test.png",
      content_b64: "!!!invalid!!!",
      requestId: "ua-5",
    });
    expect(fm.saveFileForSession).not.toHaveBeenCalled();
    const msg = sent[0] as { type: string; message: string };
    expect(msg.type).toBe("error");
    expect(msg.message).toMatch(/INVALID_REQUEST.*base64/);
  });

  it("padding 잘못 (length % 4 != 0) → INVALID_REQUEST", async () => {
    // "abc"는 길이 3이라 base64 padding 규칙 위반
    const { dispatcher, sent, fm } = createDispatcher();
    await dispatcher.dispatch({
      type: "upload_attachment",
      session_id: "sess-1",
      filename: "test.png",
      content_b64: "abc",
      requestId: "ua-6",
    });
    expect(fm.saveFileForSession).not.toHaveBeenCalled();
    const msg = sent[0] as { type: string; message: string };
    expect(msg.type).toBe("error");
    expect(msg.message).toMatch(/INVALID_REQUEST.*base64/);
  });
});

describe("CommandDispatcher.delete_session_attachments", () => {
  it("정상 흐름: cleanupSession 호출 + delete_session_attachments_result ACK", async () => {
    const { dispatcher, sent, fm } = createDispatcher();
    await dispatcher.dispatch({
      type: "delete_session_attachments",
      session_id: "sess-1",
      requestId: "da-1",
    });
    expect(fm.cleanupSession).toHaveBeenCalledWith("sess-1");
    expect(sent).toHaveLength(1);
    const msg = sent[0] as Record<string, unknown>;
    expect(msg.type).toBe("delete_session_attachments_result");
    expect(msg.requestId).toBe("da-1");
    expect(msg.cleaned).toBe(true);
    expect(typeof msg.files_removed).toBe("number");
  });

  it("session_id 누락 → INVALID_REQUEST error", async () => {
    const { dispatcher, sent, fm } = createDispatcher();
    await dispatcher.dispatch({
      type: "delete_session_attachments",
      requestId: "da-2",
    });
    expect(fm.cleanupSession).not.toHaveBeenCalled();
    const msg = sent[0] as { type: string; message: string };
    expect(msg.type).toBe("error");
    expect(msg.message).toContain("INVALID_REQUEST");
    expect(msg.message).toContain("session_id");
  });

  it("requestId 없으면 ACK 발행 안 함", async () => {
    const { dispatcher, sent, fm } = createDispatcher();
    await dispatcher.dispatch({
      type: "delete_session_attachments",
      session_id: "sess-1",
    });
    expect(fm.cleanupSession).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(0);
  });
});

describe("CommandDispatcher.download_attachment", () => {
  it("정상 흐름: download_attachment_result ACK (content_b64·filename·size)", async () => {
    // isUnderBase=true로 mock, readFile은 실제 파일 대신 Buffer 반환 필요.
    // dispatcher.ts의 readFile은 node:fs/promises를 직접 import하므로,
    // 실제 파일 대신 테스트 임시 파일을 만들어 사용한다.
    const { mkdtemp, writeFile: wf, rm: rm2 } = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dl-test-"));
    const testFile = path.join(tmpDir, "hello.txt");
    await wf(testFile, "hello content");

    const fm = makeDefaultFileManager({
      isUnderBase: vi.fn(async () => true),
    });
    const { dispatcher, sent } = createDispatcher({ fileManager: fm });
    await dispatcher.dispatch({
      type: "download_attachment",
      path: testFile,
      requestId: "dl-1",
    });

    await rm2(tmpDir, { recursive: true, force: true });

    expect(sent).toHaveLength(1);
    const msg = sent[0] as Record<string, unknown>;
    expect(msg.type).toBe("download_attachment_result");
    expect(msg.requestId).toBe("dl-1");
    expect(typeof msg.content_b64).toBe("string");
    expect(msg.filename).toBe("hello.txt");
    expect(msg.content_type).toBe("text/plain");
    expect(typeof msg.size).toBe("number");
  });

  it("path 누락 → INVALID_REQUEST error", async () => {
    const { dispatcher, sent, fm } = createDispatcher();
    await dispatcher.dispatch({
      type: "download_attachment",
      requestId: "dl-2",
    });
    expect(fm.isUnderBase).not.toHaveBeenCalled();
    const msg = sent[0] as { type: string; message: string };
    expect(msg.type).toBe("error");
    expect(msg.message).toContain("INVALID_REQUEST");
    expect(msg.message).toContain("path");
  });

  it("isUnderBase=false (traversal) → INVALID_REQUEST error", async () => {
    const fm = makeDefaultFileManager({
      isUnderBase: vi.fn(async () => false),
    });
    const { dispatcher, sent } = createDispatcher({ fileManager: fm });
    await dispatcher.dispatch({
      type: "download_attachment",
      path: "/etc/passwd",
      requestId: "dl-3",
    });
    const msg = sent[0] as { type: string; message: string };
    expect(msg.type).toBe("error");
    expect(msg.message).toContain("INVALID_REQUEST");
    expect(msg.message).toContain("첨부 디렉토리 하위가 아닙니다");
  });

  it("파일 미존재 → NOT_FOUND error", async () => {
    const fm = makeDefaultFileManager({
      isUnderBase: vi.fn(async () => true),
    });
    const { dispatcher, sent } = createDispatcher({ fileManager: fm });
    await dispatcher.dispatch({
      type: "download_attachment",
      path: "/tmp/nonexistent_file_xyz_12345.txt",
      requestId: "dl-4",
    });
    const msg = sent[0] as { type: string; message: string };
    expect(msg.type).toBe("error");
    expect(msg.message).toContain("NOT_FOUND");
    expect(msg.message).toContain("파일이 존재하지 않습니다");
  });
});
