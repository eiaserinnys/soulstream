import { describe, expect, it, vi } from "vitest";

import { ResumeRejectedError } from "../../src/task/resume_rejected_error.js";
import { AutoResumeTransition } from "../../src/task/task_auto_resume_transition.js";
import { LlmSessionContinuation } from "../../src/llm/continuation.js";
import { LlmExecutor } from "../../src/llm/executor.js";
import type { LlmAdapter, LlmCompletionRequest } from "../../src/llm/types.js";
import type { CallerInfo } from "../../src/task/task_models.js";

import { FailingLlmAdapter, MockLlmAdapter, makeLlmHarness, silentLogger } from "./llm_test_helpers.js";

type Harness = ReturnType<typeof makeLlmHarness>;

const browser: CallerInfo = {
  source: "browser",
  user_id: "u1",
  display_name: "디렉터",
};

function mockAdapter(harness: Harness): MockLlmAdapter {
  return harness.adapter as MockLlmAdapter;
}

function attachContinuation(
  harness: Harness,
  adapters: Record<string, LlmAdapter> = { openai: harness.adapter },
): void {
  harness.taskManager.attachLlmContinuation(
    new LlmSessionContinuation({
      adapters,
      db: harness.db,
      persistence: harness.persistence,
      taskManager: harness.taskManager,
      logger: silentLogger,
    }),
  );
}

async function createFinishedLlmSession(
  harness: Harness,
  overrides: Partial<LlmCompletionRequest> = {},
): Promise<string> {
  const executor = new LlmExecutor({
    adapters: { openai: harness.adapter },
    taskManager: harness.taskManager,
    persistence: harness.persistence,
    broadcaster: harness.broadcaster,
    nodeId: "test-node",
    logger: silentLogger,
  });
  const response = await executor.execute({
    provider: "openai",
    model: "gpt-test",
    messages: [
      { role: "system", content: "Translate to English" },
      { role: "user", content: "안녕" },
    ],
    max_tokens: 321,
    temperature: 0.5,
    client_id: "translate",
    caller_info: null,
    ...overrides,
  });
  return response.session_id;
}

function intervene(harness: Harness, sessionId: string, text: string, extra: object = {}) {
  const onResume = vi.fn();
  const result = harness.taskManager.addIntervention(
    { agentSessionId: sessionId, text, user: "browser", callerInfo: browser, ...extra },
    onResume,
  );
  return { result, onResume };
}

function appended(harness: Harness) {
  return harness.mocks.outboxAppend.mock.calls.map(([input]) => input as {
    event_type: string;
    payload: Record<string, unknown>;
    session_effect?: { kind: string; status?: string };
  });
}

describe("끝난 llm 세션 이어 쓰기", () => {
  it("같은 세션에 이전 이력과 이전 답과 새 글을 붙여 묻고 completed로 끝낸다", async () => {
    const harness = makeLlmHarness();
    const sessionId = await createFinishedLlmSession(harness);
    attachContinuation(harness);
    const before = appended(harness).length;
    mockAdapter(harness).complete.mockClear();

    const { result, onResume } = intervene(harness, sessionId, "더 짧게");
    await expect(result).resolves.toEqual({ autoResumed: true });
    await vi.waitFor(() => expect(harness.taskManager.getTask(sessionId)?.status).toBe("completed"));

    const added = appended(harness).slice(before);
    expect(added.map((event) => event.session_effect?.kind ?? event.event_type)).toEqual([
      "append_metadata",
      "last_message",
      "running_transition",
      "last_message",
      "terminal_transition",
    ]);
    const userMessage = added.find((event) => event.event_type === "user_message")!;
    expect(userMessage.payload).toMatchObject({
      text: "더 짧게",
      provider: "openai",
      model: "gpt-test",
      max_tokens: 321,
      temperature: 0.5,
      client_id: "translate",
      messages: [
        { role: "system", content: "Translate to English" },
        { role: "user", content: "안녕" },
        { role: "assistant", content: "Mock response" },
        { role: "user", content: "더 짧게" },
      ],
    });
    expect(added.find((event) => event.event_type === "assistant_message")?.payload).toMatchObject({
      content: "Mock response",
      provider: "openai",
      model: "gpt-test",
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    expect(added.at(-1)?.session_effect).toMatchObject({ status: "completed" });
    expect(mockAdapter(harness).complete).toHaveBeenCalledWith({
      model: "gpt-test",
      messages: (userMessage.payload as { messages: unknown }).messages,
      maxTokens: 321,
      temperature: 0.5,
    });
    expect(onResume).not.toHaveBeenCalled();
    expect(harness.mocks.registerSession).toHaveBeenCalledTimes(1);
    expect(harness.taskManager.getTask(sessionId)?.clientId).toBe("translate");
  });

  it("두 번 이어 쓰면 둘째 이력에 첫째 문답이 들어간다", async () => {
    const harness = makeLlmHarness();
    const sessionId = await createFinishedLlmSession(harness);
    attachContinuation(harness);

    await intervene(harness, sessionId, "둘째 질문").result;
    await vi.waitFor(() => expect(harness.mocks.outboxAppend.mock.calls.at(-1)?.[0].event_type).toBe("session_ended"));
    mockAdapter(harness).complete.mockResolvedValueOnce({ content: "둘째 답", inputTokens: 1, outputTokens: 1 });
    await intervene(harness, sessionId, "셋째 질문").result;
    await vi.waitFor(() => expect(mockAdapter(harness).complete).toHaveBeenCalledTimes(3));

    expect(mockAdapter(harness).complete.mock.calls.at(-1)?.[0]).toMatchObject({
      messages: [
        { role: "system", content: "Translate to English" },
        { role: "user", content: "안녕" },
        { role: "assistant", content: "Mock response" },
        { role: "user", content: "둘째 질문" },
        { role: "assistant", content: "Mock response" },
        { role: "user", content: "셋째 질문" },
      ],
    });
  });

  it("어댑터가 실패하면 error 이벤트와 error 마감을 남긴다", async () => {
    const harness = makeLlmHarness();
    const sessionId = await createFinishedLlmSession(harness);
    const failing = new FailingLlmAdapter();
    attachContinuation(harness, { openai: failing });
    const before = appended(harness).length;

    await expect(intervene(harness, sessionId, "다시").result).resolves.toEqual({ autoResumed: true });
    await vi.waitFor(() => expect(harness.taskManager.getTask(sessionId)?.status).toBe("error"));

    const added = appended(harness).slice(before);
    expect(added.find((event) => event.event_type === "error")?.payload).toMatchObject({
      message: expect.stringContaining("rate limited"),
      provider: "openai",
      model: "gpt-test",
    });
    expect(added.at(-1)?.session_effect).toMatchObject({ kind: "terminal_transition", status: "error" });
  });

  it.each([
    ["provider와 model을 찾지 못하면", "이 llm 세션의 모델 정보를 찾지 못해", { openai: new MockLlmAdapter() }, true],
    ["그 노드에 provider 키가 없으면", "이 노드에 openai 키가 없어 이어 쓸 수 없습니다", {}, false],
  ])("%s 이벤트를 쓰지 않고 거절한다", async (_name, message, adapters, wipeModel) => {
    const harness = makeLlmHarness();
    const sessionId = await createFinishedLlmSession(harness);
    attachContinuation(harness, adapters);
    if (wipeModel) {
      harness.mocks.readEvents.mockImplementation(async () => []);
    }
    const before = harness.mocks.outboxAppend.mock.calls.length;

    const rejected = intervene(harness, sessionId, "다시").result;
    await expect(rejected).rejects.toThrow(message);
    await expect(rejected).rejects.toBeInstanceOf(ResumeRejectedError);

    expect(harness.mocks.outboxAppend.mock.calls.length).toBe(before);
    expect(harness.taskManager.getTask(sessionId)?.status).toBe("completed");
  });

  it("첨부가 실려 오면 첨부를 받지 않는다는 문구로 거절한다", async () => {
    const harness = makeLlmHarness();
    const sessionId = await createFinishedLlmSession(harness);
    attachContinuation(harness);
    const before = harness.mocks.outboxAppend.mock.calls.length;

    const rejected = intervene(harness, sessionId, "이 파일", { attachmentPaths: ["/tmp/a.png"] }).result;
    await expect(rejected).rejects.toThrow("llm 세션은 첨부를 받지 않습니다");
    await expect(rejected).rejects.toBeInstanceOf(ResumeRejectedError);
    expect(harness.mocks.outboxAppend.mock.calls.length).toBe(before);
  });

  it("아직 답하는 중이면 영구 거절 종류로 거절한다", async () => {
    const harness = makeLlmHarness();
    const sessionId = await createFinishedLlmSession(harness);
    let finish!: () => void;
    const slow = new MockLlmAdapter();
    slow.complete.mockImplementation(
      () => new Promise((resolve) => {
        finish = () => resolve({ content: "늦은 답", inputTokens: 1, outputTokens: 1 });
      }),
    );
    const continuation = new LlmSessionContinuation({
      adapters: { openai: slow },
      db: harness.db,
      persistence: harness.persistence,
      taskManager: harness.taskManager,
      logger: silentLogger,
    });
    const task = harness.taskManager.getTask(sessionId)!;
    const message = { text: "다시", user: "browser", callerInfo: browser };

    const turn = await continuation.prepare(task, message);
    const running = turn.run();
    await vi.waitFor(() => expect(slow.complete).toHaveBeenCalled());

    const rejected = continuation.prepare(task, message);
    await expect(rejected).rejects.toBeInstanceOf(ResumeRejectedError);
    await expect(rejected).rejects.toThrow("아직 답하는 중입니다");

    finish();
    await running;
  });

  it("profileId가 없는 llm 세션도 프로필 검사에 걸리지 않고 claude 엔진을 시작하지 않는다", async () => {
    const harness = makeLlmHarness();
    const sessionId = await createFinishedLlmSession(harness);
    const task = harness.taskManager.getTask(sessionId)!;
    expect(task.profileId).toBeUndefined();
    const transition = new AutoResumeTransition({
      logger: silentLogger,
      persistence: harness.persistence,
      agentRegistry: { get: () => undefined } as never,
    });
    transition.attachLlmContinuation(
      new LlmSessionContinuation({
        adapters: { openai: harness.adapter },
        db: harness.db,
        persistence: harness.persistence,
        taskManager: harness.taskManager,
        logger: silentLogger,
      }),
    );
    const onResume = vi.fn();

    await expect(
      transition.resume(task, { text: "이어서", user: "browser", callerInfo: browser }, onResume),
    ).resolves.toEqual({ autoResumed: true });
    await vi.waitFor(() => expect(task.status).toBe("completed"));

    expect(onResume).not.toHaveBeenCalled();
  });

  it("llm 이어 쓰기가 달려 있지 않으면 영구 거절 종류로 거절한다", async () => {
    const harness = makeLlmHarness();
    const sessionId = await createFinishedLlmSession(harness);
    const task = harness.taskManager.getTask(sessionId)!;
    const transition = new AutoResumeTransition({ logger: silentLogger, persistence: harness.persistence });

    await expect(
      transition.resume(task, { text: "다시", user: "browser", callerInfo: browser }, vi.fn()),
    ).rejects.toBeInstanceOf(ResumeRejectedError);
  });

  it("profileId가 없는 claude 세션은 영구 거절 문구로 거절하고 unknown agent profile은 그대로 둔다", async () => {
    const harness = makeLlmHarness();
    const sessionId = await createFinishedLlmSession(harness);
    const task = harness.taskManager.getTask(sessionId)!;
    task.sessionType = "claude";
    const transition = new AutoResumeTransition({
      logger: silentLogger,
      persistence: harness.persistence,
      agentRegistry: { get: () => undefined } as never,
    });
    const message = { text: "다시", user: "browser", callerInfo: browser };

    const noProfile = transition.resume(task, message, vi.fn());
    await expect(noProfile).rejects.toBeInstanceOf(ResumeRejectedError);
    await expect(noProfile).rejects.toThrow("이 세션은 에이전트 정보가 없어 이어 쓸 수 없습니다");

    task.profileId = "ghost";
    const unknownProfile = transition.resume(task, message, vi.fn());
    await expect(unknownProfile).rejects.toThrow("unknown agent profile ghost");
    await expect(unknownProfile).rejects.not.toBeInstanceOf(ResumeRejectedError);
  });
});
