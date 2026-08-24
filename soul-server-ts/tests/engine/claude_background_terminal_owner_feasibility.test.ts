import type {
  PreToolUseHookSpecificOutput,
  Query,
  SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentInput,
  BashInput,
} from "@anthropic-ai/claude-agent-sdk/sdk-tools";
import { describe, expect, it } from "vitest";

/**
 * Upstream-seam tripwire for Claude background task lifetime recovery.
 *
 * Frozen evidence: origin/test/claude-background-task-reds
 * - acb6ecb21cd57f51a2235717132a481e307e2db5 (live CLI lifetime diagnosis)
 * - b0a961f2657ba5b1aa3e3b5ced54247ccbf51dc4 (deterministic lifetime RED)
 * - c8c15288355cb2e95afab9d9cc0fd0541c762b9b (graceful evidence chain)
 * - 9dc859b9d5a662ab7018a76911a511fbddf0d0c1 (durable liveness RED)
 *
 * If this test stops compiling because the SDK gained a handled-result or
 * task adopt/reattach seam, move the evidence branch onto the latest main and
 * resume A GREEN from those frozen contracts. Do not turn this into a skip.
 */

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false;
type Expect<Value extends true> = Value;

type _PreToolUseHasNoHandledResult = Expect<Equal<
  Extract<
    keyof PreToolUseHookSpecificOutput,
    | "handled"
    | "handledResult"
    | "result"
    | "toolResult"
    | "replacementResult"
    | "skipExecution"
    | "executeExternally"
  >,
  never
>>;
type _PreToolUseDecisionHasNoHandledMode = Expect<Equal<
  Extract<
    NonNullable<PreToolUseHookSpecificOutput["permissionDecision"]>,
    "handled" | "replace" | "external"
  >,
  never
>>;
type _SpawnOverrideHasNoTaskAttachIdentity = Expect<Equal<
  Extract<
    keyof SpawnOptions,
    "taskId" | "toolUseId" | "attachId" | "resumeToken" | "outputCursor"
  >,
  never
>>;
type _QueryHasNoTaskAdoptionOrTerminalInjection = Expect<Equal<
  Extract<
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
  >,
  never
>>;

describe("Claude background terminal owner feasibility", () => {
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
