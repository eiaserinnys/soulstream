import { afterEach, describe, expect, it, vi } from "vitest";

import { AnthropicAdapter, OpenAIAdapter } from "../../src/llm/adapters.js";

describe("LLM adapters", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("OpenAI chat completions 요청과 usage를 매핑한다", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "안녕" } }],
          usage: { prompt_tokens: 7, completion_tokens: 3 },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new OpenAIAdapter("openai-key", "https://openai.test/v1");
    const result = await adapter.complete({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "Hello" }],
      maxTokens: 64,
      temperature: 0.1,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://openai.test/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer openai-key" }),
      }),
    );
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toMatchObject({
      model: "gpt-4o-mini",
      max_completion_tokens: 64,
      temperature: 0.1,
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(result).toEqual({ content: "안녕", inputTokens: 7, outputTokens: 3 });
  });

  it("Anthropic messages 요청은 system 메시지를 별도 필드로 보낸다", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: "Hello" }],
          usage: { input_tokens: 11, output_tokens: 4 },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new AnthropicAdapter("anthropic-key", "https://anthropic.test");
    const result = await adapter.complete({
      model: "claude-3-5-haiku-latest",
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hi" },
      ],
      maxTokens: 32,
      temperature: null,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://anthropic.test/v1/messages",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-api-key": "anthropic-key",
          "anthropic-version": "2023-06-01",
        }),
      }),
    );
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toMatchObject({
      model: "claude-3-5-haiku-latest",
      max_tokens: 32,
      system: "You are helpful.",
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(result).toEqual({ content: "Hello", inputTokens: 11, outputTokens: 4 });
  });
});
