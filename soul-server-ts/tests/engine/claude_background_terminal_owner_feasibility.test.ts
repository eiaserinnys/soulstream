import type {
  PreToolUseHookSpecificOutput,
  Query,
  SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentInput,
  BashInput,
} from "@anthropic-ai/claude-agent-sdk/sdk-tools";
import { describe, expectTypeOf, it } from "vitest";

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
    expectTypeOf<true>().toExtend<NonNullable<AgentInput["run_in_background"]>>();
    expectTypeOf<"remote">().toExtend<NonNullable<AgentInput["isolation"]>>();
    expectTypeOf<true>().toExtend<NonNullable<BashInput["run_in_background"]>>();
  });
});
