import type {
  PreToolUseHookSpecificOutput,
  Query,
  SpawnOptions,
  SubagentStartHookSpecificOutput,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentInput,
  BashInput,
} from "@anthropic-ai/claude-agent-sdk/sdk-tools";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { GENERIC_HOOK_EVENTS } from "../../src/engine/claude_sdk_constants.js";
import type { EventQueue } from "../../src/engine/claude_sdk_event_queue.js";
import { ClaudeSdkEventMapper } from "../../src/engine/claude_sdk_event_mapper.js";
import { buildClaudeSdkHooks } from "../../src/engine/claude_sdk_hooks.js";
import { ClaudeRuntimeState } from "../../src/engine/claude_sdk_runtime_state.js";
import type { ClaudeClientEvent } from "../../src/engine/claude_event_mapper.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false;
type Expect<Value extends true> = Value;

type _PreToolUseCannotReplaceExecution = Expect<Equal<
  keyof PreToolUseHookSpecificOutput,
  | "hookEventName"
  | "permissionDecision"
  | "permissionDecisionReason"
  | "updatedInput"
  | "additionalContext"
>>;
type _SubagentStartCannotReplaceExecution = Expect<Equal<
  keyof SubagentStartHookSpecificOutput,
  "hookEventName" | "additionalContext"
>>;
type _SpawnOverrideHasNoTaskOrAttachIdentity = Expect<Equal<
  keyof SpawnOptions,
  "command" | "args" | "cwd" | "env" | "signal"
>>;
type _QueryHasNoTaskAdoptionOrTerminalInjection = Expect<Equal<
  Extract<
    keyof Query,
    "reattach" | "adoptTask" | "completeTask" | "injectTaskResult"
  >,
  never
>>;

function makeOutputQueue(push: (event: ClaudeClientEvent) => boolean): EventQueue<ClaudeClientEvent> {
  return {
    push,
    close: vi.fn(),
    fail: vi.fn(),
    next: vi.fn(),
    return: vi.fn(),
    [Symbol.asyncIterator]() {
      return this;
    },
  } as unknown as EventQueue<ClaudeClientEvent>;
}

describe("Claude background terminal owner feasibility", () => {
  it("keeps PreToolUse as runner-local Agent intent observation rather than a host handoff", async () => {
    const push = vi.fn(() => true);
    const hooks = buildClaudeSdkHooks({
      output: makeOutputQueue(push),
      systemPrompt: undefined,
      eventMapper: new ClaudeSdkEventMapper(new ClaudeRuntimeState()),
      runtimeState: new ClaudeRuntimeState(),
      logger: pino({ enabled: false }),
    });

    expect(GENERIC_HOOK_EVENTS).not.toContain("PreToolUse");
    expect(hooks.PreToolUse).toMatchObject([
      { matcher: "Agent", hooks: [expect.any(Function)] },
    ]);

    const result = await hooks.PreToolUse?.[0]?.hooks[0]?.(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Agent",
        tool_use_id: "toolu-background-agent",
        tool_input: {
          description: "Inspect source",
          prompt: "Inspect the source",
          run_in_background: true,
        },
        session_id: "sdk-session",
        transcript_path: "/tmp/transcript.jsonl",
        cwd: "/tmp/workspace",
      },
      "toolu-background-agent",
      { signal: new AbortController().signal },
    );

    expect(result).toEqual({});
    expect(push).not.toHaveBeenCalled();
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

  it("locks the upstream hook, spawn, and Query surfaces to observation without adoption", () => {
    const compileProof = {
      preToolUseCanReplaceExecution: false,
      subagentStartCanReplaceExecution: false,
      spawnOverrideCarriesTaskIdentity: false,
      queryCanAdoptOrInjectTerminal: false,
    } as const;

    expect(compileProof).toEqual({
      preToolUseCanReplaceExecution: false,
      subagentStartCanReplaceExecution: false,
      spawnOverrideCarriesTaskIdentity: false,
      queryCanAdoptOrInjectTerminal: false,
    });
  });
});
