import { describe, expect, it } from "vitest";

import { LlmExecutor, ProviderNotConfiguredError } from "../../src/llm/executor.js";

import { FailingLlmAdapter, makeLlmHarness, silentLogger } from "./llm_test_helpers.js";

describe("LlmExecutor", () => {
  it("LLM 요청을 llm 세션으로 등록하고 이벤트와 완료 상태를 기록한다", async () => {
    const harness = makeLlmHarness();
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
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "Translate this" }],
      max_tokens: 128,
      temperature: null,
      client_id: "translate",
      caller_info: null,
    });

    expect(response.session_id).toMatch(/^llm-\d{14}-[0-9a-f]{8}$/);
    expect(response).toMatchObject({
      content: "Mock response",
      usage: { input_tokens: 10, output_tokens: 5 },
      model: "gpt-4o-mini",
      provider: "openai",
    });

    expect(harness.mocks.registerSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: response.session_id,
        sessionType: "llm",
        clientId: "translate",
        agentId: null,
      }),
    );
    expect(harness.mocks.getFolderById).toHaveBeenCalledWith("llm");
    expect(harness.mocks.appendEvent).toHaveBeenCalledTimes(3);
    expect(harness.mocks.updateSession).toHaveBeenCalledWith(
      response.session_id,
      expect.objectContaining({
        status: "completed",
        last_event_id: 3,
        termination_reason: "completed_ok",
      }),
    );

    const task = harness.taskManager.getTask(response.session_id);
    expect(task?.sessionType).toBe("llm");
    expect(task?.clientId).toBe("translate");
    expect(task?.llmProvider).toBe("openai");
    expect(task?.llmModel).toBe("gpt-4o-mini");
    expect(task?.llmUsage).toEqual({ input_tokens: 10, output_tokens: 5 });
    expect(task?.callerInfo).toEqual({
      source: "system",
      agent_node: "test-node",
      display_name: "Soulstream",
      user_id: null,
      avatar_url: "/api/system/portraits/system",
    });

    expect(harness.sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "session_created",
          session: expect.objectContaining({
            session_type: "llm",
            llm_provider: "openai",
            llm_model: "gpt-4o-mini",
            client_id: "translate",
          }),
        }),
        expect.objectContaining({
          type: "session_updated",
          agent_session_id: response.session_id,
          status: "completed",
          session_type: "llm",
        }),
      ]),
    );
  });

  it("caller_info가 있으면 system fallback 대신 그대로 보존한다", async () => {
    const harness = makeLlmHarness();
    const executor = new LlmExecutor({
      adapters: { openai: harness.adapter },
      taskManager: harness.taskManager,
      persistence: harness.persistence,
      broadcaster: harness.broadcaster,
      nodeId: "test-node",
      logger: silentLogger,
    });
    const callerInfo = {
      source: "channel_observer",
      display_name: "채널 관찰자",
      avatar_url: "/api/system/portraits/channel_observer",
    };

    const response = await executor.execute({
      provider: "openai",
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 128,
      temperature: 0.2,
      client_id: null,
      caller_info: callerInfo,
    });

    expect(harness.taskManager.getTask(response.session_id)?.callerInfo).toEqual(callerInfo);
    expect(harness.mocks.appendMetadata).toHaveBeenCalledWith(response.session_id, {
      type: "caller_info",
      value: callerInfo,
    });
  });

  it("설정되지 않은 provider는 세션을 만들기 전에 명시 오류를 낸다", async () => {
    const harness = makeLlmHarness();
    const executor = new LlmExecutor({
      adapters: { openai: harness.adapter },
      taskManager: harness.taskManager,
      persistence: harness.persistence,
      broadcaster: harness.broadcaster,
      nodeId: "test-node",
      logger: silentLogger,
    });

    await expect(
      executor.execute({
        provider: "anthropic",
        model: "claude-3-5-haiku-latest",
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 128,
        temperature: null,
        client_id: null,
        caller_info: null,
      }),
    ).rejects.toBeInstanceOf(ProviderNotConfiguredError);
    expect(harness.mocks.registerSession).not.toHaveBeenCalled();
  });

  it("provider 오류는 error 이벤트와 error 상태로 기록한 뒤 다시 throw한다", async () => {
    const harness = makeLlmHarness(new FailingLlmAdapter());
    const executor = new LlmExecutor({
      adapters: { openai: harness.adapter },
      taskManager: harness.taskManager,
      persistence: harness.persistence,
      broadcaster: harness.broadcaster,
      nodeId: "test-node",
      logger: silentLogger,
    });

    await expect(
      executor.execute({
        provider: "openai",
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 128,
        temperature: null,
        client_id: null,
        caller_info: null,
      }),
    ).rejects.toThrow(/rate limited/);

    const sessionId = harness.mocks.registerSession.mock.calls[0]?.[0].sessionId;
    expect(harness.mocks.appendEvent).toHaveBeenCalledTimes(3);
    expect(harness.mocks.updateSession).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        status: "error",
        last_event_id: 3,
        termination_reason: "unknown",
      }),
    );
  });
});
