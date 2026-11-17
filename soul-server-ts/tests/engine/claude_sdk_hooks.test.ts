import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ClaudeClientEvent } from "../../src/engine/claude_client_event.js";
import { buildClaudeSdkHooks } from "../../src/engine/claude_sdk_hooks.js";
import type { EventQueue } from "../../src/engine/claude_sdk_event_queue.js";
import { ClaudeSdkEventMapper } from "../../src/engine/claude_sdk_event_mapper.js";
import { ClaudeRuntimeState } from "../../src/engine/claude_sdk_runtime_state.js";
import {
  registerSecretValueSource,
  resetSecretMaskerForTests,
} from "../../src/secret_masker.js";

type HookCallback = (
  input: Record<string, unknown>,
  toolUseId: string | undefined,
  options: { signal: AbortSignal },
) => Promise<Record<string, unknown>>;

function makeHooks() {
  const pushed: ClaudeClientEvent[] = [];
  const output = {
    push: (event: ClaudeClientEvent) => {
      pushed.push(event);
      return true;
    },
    close: () => undefined,
    fail: () => undefined,
    next: async () => ({ done: true, value: undefined }),
    return: async () => ({ done: true, value: undefined }),
    [Symbol.asyncIterator]() {
      return this;
    },
  } as unknown as EventQueue<ClaudeClientEvent>;
  const runtimeState = new ClaudeRuntimeState();
  const eventMapper = new ClaudeSdkEventMapper(runtimeState);
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
  const hooks = buildClaudeSdkHooks({
    output,
    systemPrompt: undefined,
    eventMapper,
    runtimeState,
    logger,
  });
  const postToolUse = hooks.PostToolUse?.[0]?.hooks[0] as unknown as HookCallback;
  const userPromptSubmit = hooks.UserPromptSubmit?.[0]?.hooks[0] as unknown as HookCallback;
  return { hooks, pushed, postToolUse, userPromptSubmit };
}

function hookOptions(): { signal: AbortSignal } {
  return { signal: new AbortController().signal };
}

function registeredSecret(): void {
  registerSecretValueSource("test", () => [
    { name: "env:TEST_API_KEY", value: "test-secret-hook-value" },
  ]);
}

describe("buildClaudeSdkHooks secret masking", () => {
  beforeEach(() => {
    resetSecretMaskerForTests();
  });

  afterEach(() => {
    resetSecretMaskerForTests();
  });

  it("replaces PostToolUse tool output before it reaches the model", async () => {
    registeredSecret();
    const { postToolUse, pushed } = makeHooks();
    const input = {
      session_id: "session-hook",
      transcript_path: "/tmp/transcript.jsonl",
      cwd: "/tmp",
      permission_mode: "default",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "grep -R test-secret-hook-value ." },
      tool_response: {
        stdout: "Authorization: Bearer test-secret-hook-value",
        stderr: "",
        interrupted: false,
      },
      tool_use_id: "tool-1",
    };

    const result = await postToolUse(input, undefined, hookOptions());

    expect(result).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        updatedToolOutput: {
          stdout: "Authorization: Bearer [REDACTED:env:TEST_API_KEY]",
          stderr: "",
          interrupted: false,
        },
      },
    });
    expect(JSON.stringify(pushed)).not.toContain("test-secret-hook-value");
    const hookEvent = pushed[0] as { hookInput: Record<string, unknown> };
    expect((hookEvent.hookInput.tool_input as Record<string, unknown>).command)
      .toBe("grep -R [REDACTED:env:TEST_API_KEY] .");
    expect(
      (input.tool_response as Record<string, unknown>).stdout,
    ).toBe("Authorization: Bearer test-secret-hook-value");
  });

  it("returns an empty result when the PostToolUse output has nothing to mask", async () => {
    const { postToolUse, pushed } = makeHooks();
    const input = {
      session_id: "session-hook",
      transcript_path: "/tmp/transcript.jsonl",
      cwd: "/tmp",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_response: { stdout: "clean output", stderr: "", interrupted: false },
      tool_use_id: "tool-2",
    };

    const result = await postToolUse(input, undefined, hookOptions());

    expect(result).toEqual({});
    expect(pushed).toHaveLength(1);
  });

  it("masks stored input for generic hooks other than PostToolUse", async () => {
    registeredSecret();
    const { userPromptSubmit, pushed } = makeHooks();
    const input = {
      session_id: "session-hook",
      transcript_path: "/tmp/transcript.jsonl",
      cwd: "/tmp",
      hook_event_name: "UserPromptSubmit",
      prompt: "use test-secret-hook-value here",
    };

    const result = await userPromptSubmit(input, "tool-9", hookOptions());

    expect(result).toEqual({});
    expect(JSON.stringify(pushed)).not.toContain("test-secret-hook-value");
    const hookEvent = pushed[0] as { hookInput: Record<string, unknown> };
    expect(hookEvent.hookInput.prompt).toBe("use [REDACTED:env:TEST_API_KEY] here");
    expect(input.prompt).toBe("use test-secret-hook-value here");
  });
});
