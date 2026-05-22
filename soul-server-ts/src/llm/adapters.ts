import type { LlmAdapter, LlmMessage, LlmResult } from "./types.js";

interface OpenAIChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  } | null;
  error?: {
    message?: string;
  };
}

interface AnthropicMessagesResponse {
  content?: Array<{
    type?: string;
    text?: string;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  error?: {
    message?: string;
  };
}

export class OpenAIAdapter implements LlmAdapter {
  private readonly baseUrl: string;

  constructor(private readonly apiKey: string, baseUrl = "https://api.openai.com/v1") {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async complete(params: {
    model: string;
    messages: LlmMessage[];
    maxTokens: number;
    temperature: number | null;
  }): Promise<LlmResult> {
    const body: Record<string, unknown> = {
      model: params.model,
      messages: params.messages.map((m) => ({ role: m.role, content: m.content })),
      max_completion_tokens: params.maxTokens,
    };
    if (params.temperature !== null) {
      body.temperature = params.temperature;
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const data = await readJson<OpenAIChatCompletionResponse>(response);
    if (!response.ok) {
      throw new Error(data.error?.message ?? `OpenAI request failed: ${response.status}`);
    }

    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error(`OpenAI returned empty choices for model=${params.model}`);
    }

    return {
      content,
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
    };
  }
}

export class AnthropicAdapter implements LlmAdapter {
  private readonly baseUrl: string;

  constructor(private readonly apiKey: string, baseUrl = "https://api.anthropic.com") {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async complete(params: {
    model: string;
    messages: LlmMessage[];
    maxTokens: number;
    temperature: number | null;
  }): Promise<LlmResult> {
    const systemParts: string[] = [];
    const apiMessages: Array<{ role: "user" | "assistant"; content: string }> = [];
    for (const message of params.messages) {
      if (message.role === "system") {
        systemParts.push(message.content);
      } else {
        apiMessages.push({ role: message.role, content: message.content });
      }
    }

    const body: Record<string, unknown> = {
      model: params.model,
      messages: apiMessages,
      max_tokens: params.maxTokens,
    };
    if (systemParts.length > 0) {
      body.system = systemParts.join("\n\n");
    }
    if (params.temperature !== null) {
      body.temperature = params.temperature;
    }

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const data = await readJson<AnthropicMessagesResponse>(response);
    if (!response.ok) {
      throw new Error(data.error?.message ?? `Anthropic request failed: ${response.status}`);
    }

    const content = (data.content ?? [])
      .map((block) => (typeof block.text === "string" ? block.text : ""))
      .join("");

    return {
      content,
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
    };
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`LLM provider returned non-JSON response: ${response.status}`);
  }
}
