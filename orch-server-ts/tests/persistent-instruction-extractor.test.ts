import { describe, expect, it, vi } from "vitest";

import {
  classifyPersistentInstruction,
} from "../src/relevance/typesafe_client.js";
import {
  createPersistentInstructionExtractor,
  PERSISTENT_INSTRUCTION_OUTPUT_SCHEMA,
} from "../src/turn-summary/persistent_instruction_extractor.js";
import type { TurnSummaryConfig } from
  "../src/turn-summary/turn_summary_config.js";

const CONFIG: TurnSummaryConfig = {
  enabled: true,
  instruction: "일반 요약 설정은 추출 prompt에 넣지 않는다.",
  storyInstruction: "줄거리 설정은 추출 prompt에 넣지 않는다.",
  storyFoldThreshold: 10,
  storyFoldBatchSize: 5,
  storyCompletionGraceMs: 1_800_000,
  storyCompletionMinSummaries: 5,
  storyCompletionSweepIntervalMs: 60_000,
  storyNarrativeMaxChars: 1_500,
  provider: "codex",
  model: "gpt-5.6-luna",
  storyModel: "gpt-5.6-luna",
  reasoningEffort: "high",
  timeoutMs: 30_000,
  maxAttempts: 2,
  codexConcurrencyLimit: 2,
  codepointLimit: 6_000,
  historyLimit: 5,
  excludedFolderIds: [],
};

describe("classifyPersistentInstruction", () => {
  it("sends only the current raw user text as one Jev noul question", async () => {
    const userText = "앞으로는 먼저 근거를 확인해 줘.";
    const fetchImpl = vi.fn(async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => new Response(JSON.stringify({
      answers: { long_term_correction: { noul: 0.91 } },
    }), { status: 200 }));

    await expect(classifyPersistentInstruction({
      userText,
      apiKey: "test-typesafe-key",
      timeoutMs: 1_234,
      fetchImpl,
    })).resolves.toEqual({ confidence: 0.91 });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init?.method).toBe("POST");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(payload.model).toBe("jev-latest");
    expect(payload.state).toEqual({ request: userText });
    expect(payload.questions).toEqual({
      long_term_correction: {
        type: "noul",
        instructions: expect.any(String),
        criteria: {
          true: expect.any(String),
          false: expect.any(String),
        },
      },
    });
    expect(JSON.stringify(payload)).not.toContain("assistant");
    expect(JSON.stringify(payload)).not.toContain("history");
    expect(JSON.stringify(payload)).not.toContain("activeInstructions");
  });

  it.each([
    ["missing answer", {}],
    ["missing noul", { long_term_correction: {} }],
    ["string value", { long_term_correction: { noul: "0.9" } }],
    ["below zero", { long_term_correction: { noul: -0.01 } }],
    ["above one", { long_term_correction: { noul: 1.01 } }],
  ])("rejects an invalid Jev result: %s", async (_label, answers) => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ answers }), {
      status: 200,
    }));

    await expect(classifyPersistentInstruction({
      userText: "현재 발화",
      apiKey: "test-typesafe-key",
      timeoutMs: 1_234,
      fetchImpl,
    })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("persistent instruction extraction", () => {
  it("uses the exact Sol output contract without summary or per-item confidence", () => {
    expect(PERSISTENT_INSTRUCTION_OUTPUT_SCHEMA).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["standing_instructions"],
      properties: {
        standing_instructions: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["text", "existing_id", "source_quote"],
            properties: {
              text: { type: "string", minLength: 1 },
              existing_id: { type: ["string", "null"] },
              source_quote: { type: "string", minLength: 1 },
            },
          },
        },
      },
    });
  });

  it.each([
    [0.79, 0],
    [0.8, 1],
  ])("calls Sol only at or above the Jev threshold (%s)", async (confidence, expectedCalls) => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      answers: { long_term_correction: { noul: confidence } },
    }), { status: 200 }));
    const generate = vi.fn().mockResolvedValue({
      content: JSON.stringify({ standing_instructions: [] }),
      model: "gpt-6.1-sol",
      latencyMs: 1,
      attempts: 1,
    });
    const extractor = createPersistentInstructionExtractor({
      apiKey: "test-typesafe-key",
      fetchImpl,
      generate,
    });

    await expect(extractor.extract({
      userText: "앞으로는 먼저 근거를 확인해 줘.",
      activeInstructions: [],
    }, CONFIG)).resolves.toEqual([]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledTimes(expectedCalls);
    if (expectedCalls === 1) {
      const [, solConfig, options] = generate.mock.calls[0] ?? [];
      expect(solConfig).toMatchObject({
        model: "gpt-6.1-sol",
        reasoningEffort: "high",
        timeoutMs: CONFIG.timeoutMs,
        codexConcurrencyLimit: CONFIG.codexConcurrencyLimit,
      });
      expect(options).toEqual({
        maxAttempts: 1,
        outputSchema: PERSISTENT_INSTRUCTION_OUTPUT_SCHEMA,
      });
      expect(String(generate.mock.calls[0]?.[0])).toContain(
        "앞으로는 먼저 근거를 확인해 줘.",
      );
      expect(String(generate.mock.calls[0]?.[0])).not.toContain(CONFIG.instruction);
      expect(String(generate.mock.calls[0]?.[0])).not.toContain(CONFIG.storyInstruction);
    }
  });

  it("keeps exact user quotes and skips only candidates with invalid quotes", async () => {
    const userText = "앞으로는 ‘정확한 인용’을 보존해 줘.";
    const generate = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        standing_instructions: [
          {
            text: "첫 후보",
            existing_id: null,
            source_quote: "assistant에만 있던 문장",
          },
          {
            text: "두 번째 후보",
            existing_id: "active-id",
            source_quote: "‘정확한 인용’",
          },
          {
            text: "빈 인용",
            existing_id: null,
            source_quote: "  ",
          },
          {
            text: "인용 누락",
            existing_id: null,
          },
          {
            text: "인용 타입 오류",
            existing_id: null,
            source_quote: 42,
          },
        ],
      }),
      model: "gpt-6.1-sol",
      latencyMs: 1,
      attempts: 1,
    });
    const extractor = createPersistentInstructionExtractor({
      apiKey: "test-typesafe-key",
      fetchImpl: async () => new Response(JSON.stringify({
        answers: { long_term_correction: { noul: 0.8 } },
      }), { status: 200 }),
      generate,
    });

    await expect(extractor.extract({
      userText,
      activeInstructions: [{ id: "active-id", text: "현재 활성 지시" }],
    }, CONFIG)).resolves.toEqual([{
      text: "두 번째 후보",
      existingId: "active-id",
      sourceQuote: "‘정확한 인용’",
    }]);

    const prompt = String(generate.mock.calls[0]?.[0]);
    expect(prompt).toContain(userText);
    expect(prompt).toContain("active-id: 현재 활성 지시");
    expect(prompt).not.toContain(CONFIG.instruction);
    expect(prompt).not.toContain("assistant에만 있던 문장");
  });

  it("rejects an invalid Sol response without returning candidates", async () => {
    const extractor = createPersistentInstructionExtractor({
      apiKey: "test-typesafe-key",
      fetchImpl: async () => new Response(JSON.stringify({
        answers: { long_term_correction: { noul: 0.8 } },
      }), { status: 200 }),
      generate: vi.fn().mockResolvedValue({
        content: "not-json",
        model: "gpt-6.1-sol",
        latencyMs: 1,
        attempts: 1,
      }),
    });

    await expect(extractor.extract({
      userText: "앞으로 간결하게 답해 줘.",
      activeInstructions: [],
    }, CONFIG)).rejects.toThrow();
  });
});
