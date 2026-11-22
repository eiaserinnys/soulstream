import type {
  PreToolUseHookSpecificOutput,
  Query,
  SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentInput,
  BashInput,
} from "@anthropic-ai/claude-agent-sdk/sdk-tools";
import { describe, expect, expectTypeOf, it } from "vitest";

describe("Claude background terminal owner feasibility", () => {
  it("keeps the SDK free of handled-result and task-adoption seams", () => {
    expectTypeOf<Extract<
      keyof PreToolUseHookSpecificOutput,
      | "handled"
      | "handledResult"
      | "result"
      | "toolResult"
      | "replacementResult"
      | "skipExecution"
      | "executeExternally"
    >>().toBeNever();
    expectTypeOf<Extract<
      NonNullable<PreToolUseHookSpecificOutput["permissionDecision"]>,
      "handled" | "replace" | "external"
    >>().toBeNever();
    expectTypeOf<Extract<
      keyof SpawnOptions,
      "taskId" | "toolUseId" | "attachId" | "resumeToken" | "outputCursor"
    >>().toBeNever();
    expectTypeOf<Extract<
      keyof Query,
      | "reattach"
      | "attachTask"
      | "reattachTask"
      | "adoptTask"
      | "resumeTask"
      | "subscribeTask"
      | "completeTask"
      | "injectTaskResult"
      | "injectToolResult"
    >>().toBeNever();
  });

  it("covers both SDK background-capable tool inputs, including remote Agent execution", () => {
    const agent = {
      description: "Inspect source",
      prompt: "Inspect the source",
      run_in_background: true,
      isolation: "remote",
    } satisfies AgentInput;
    const bash = {
      command: "printf done",
      run_in_background: true,
    } satisfies BashInput;

    expect(agent).toMatchObject({ run_in_background: true, isolation: "remote" });
    expect(bash).toMatchObject({ run_in_background: true });
  });

  it("records the upstream seams whose appearance resumes A GREEN", () => {
    const compileProof = {
      preToolUseCanHandleResult: false,
      spawnOverrideCanAttachTask: false,
      queryCanAdoptOrInjectTerminal: false,
    } as const;

    expect(compileProof).toEqual({
      preToolUseCanHandleResult: false,
      spawnOverrideCanAttachTask: false,
      queryCanAdoptOrInjectTerminal: false,
    });
  });
});
