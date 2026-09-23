import { describe, expect, it, vi } from "vitest";

import {
  CodexEphemeralExecutor,
  type CodexExecInvocation,
  type CodexExecProcessPort,
} from "../src/llm/codex_ephemeral_executor.js";
import { createSearchQueryExpander } from "../src/search/search_query_expander.js";

describe("search query expander", () => {
  it("uses the resolved model once, disables tools, and returns at most three new expressions", async () => {
    const invocations: CodexExecInvocation[] = [];
    const processPort: CodexExecProcessPort = {
      async execute(invocation, _prompt, _timeoutMs) {
        invocations.push(invocation);
        return {
          stdout: JSON.stringify({
            type: "item.completed",
            item: {
              type: "agent_message",
              text: JSON.stringify({
                queries: [
                  "원래 검색어",
                  "휴대폰 피드 지연",
                  "phone feed delay",
                  "앱 목록 응답 느림",
                  "여분 표현",
                ],
              }),
            },
          }) + "\n",
          stderr: "",
        };
      },
    };
    const resolver = {
      resolve: vi.fn(() => ({ model: "resolved-model", reasoningEffort: "max" as const })),
    };
    const expander = createSearchQueryExpander({
      executor: new CodexEphemeralExecutor({
        codexPath: "/usr/local/bin/codex",
        processPort,
        processEnv: {},
      }),
      modelResolver: resolver,
    });

    const result = await expander.expand("원래 검색어", 1_200);

    expect(result).toEqual({
      queries: ["휴대폰 피드 지연", "phone feed delay", "앱 목록 응답 느림"],
      latencyMs: expect.any(Number),
      skipped: false,
    });
    expect(resolver.resolve).toHaveBeenCalledTimes(1);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.args).toContain("resolved-model");
    expect(invocations[0]?.args).toContain('model_reasoning_effort="max"');
    expect(invocations[0]?.args).toEqual(expect.arrayContaining([
      "--disable",
      "shell_tool",
      "apps",
      "multi_agent",
      "goals",
      "remote_plugin",
      'web_search="disabled"',
    ]));
  });

  it("skips expansion for UUIDs, paths, and code identifiers", async () => {
    const execute = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const expander = createSearchQueryExpander({
      executor: new CodexEphemeralExecutor({
        codexPath: "/usr/local/bin/codex",
        processPort: { execute },
      }),
      modelResolver: { resolve: vi.fn(() => { throw new Error("must skip"); }) },
    });

    for (const query of [
      "a729f401-1bab-4a34-8fe8-6f01bca734d0",
      "packages/search-contract/src/index.ts",
      "sessionSearchId",
    ]) {
      const result = await expander.expand(query, 500);
      expect(result.skipped).toBe(true);
      expect(result.queries).toEqual([]);
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects a successful model response that adds no search expression", async () => {
    const expander = createSearchQueryExpander({
      executor: new CodexEphemeralExecutor({
        codexPath: "/usr/local/bin/codex",
        processPort: {
          async execute() {
            return {
              stdout: JSON.stringify({
                type: "item.completed",
                item: {
                  type: "agent_message",
                  text: JSON.stringify({ queries: ["원래 검색어", " "] }),
                },
              }) + "\n",
              stderr: "",
            };
          },
        },
      }),
      modelResolver: { resolve: vi.fn(() => ({ model: "resolved-model", reasoningEffort: "low" as const })) },
    });

    await expect(expander.expand("원래 검색어", 1_200)).rejects.toMatchObject({
      code: "CODEX_INVALID_OUTPUT",
    });
  });
});
