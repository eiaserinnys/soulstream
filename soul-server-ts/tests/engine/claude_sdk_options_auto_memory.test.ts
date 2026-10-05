import { describe, expect, it } from "vitest";

import { buildClaudeSdkOptions } from "../../src/engine/claude_sdk_options.js";
import type { ClaudeRunOptions } from "../../src/engine/claude_adapter.js";

/**
 * 프로필 `claude_auto_memory_enabled: false`가 SDK `settings.autoMemoryEnabled`까지
 * 가는지, 키가 없으면 `settings` 자체가 옵션에 없는지를 고정한다.
 */
function build(options: Partial<ClaudeRunOptions>) {
  return buildClaudeSdkOptions({
    options: {
      prompt: "hi",
      workspaceDir: "/tmp/auto-memory-ws",
      ...options,
    } as ClaudeRunOptions,
    abortController: new AbortController(),
    output: { push: () => {}, close: () => {} } as never,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    } as never,
    resolveClaudeExecutablePath: () => undefined,
    eventMapper: {} as never,
    runtimeState: {} as never,
    toolPermissionController: { makeCanUseTool: () => () => undefined } as never,
  });
}

describe("claude sdk options auto memory", () => {
  it("passes autoMemoryEnabled=false through settings and keeps settingSources", () => {
    const built = build({ autoMemoryEnabled: false });
    expect(built.settings).toEqual({ autoMemoryEnabled: false });
    expect(built.settingSources).toEqual(["project"]);
  });

  it("omits settings entirely when the profile did not set the key", () => {
    const built = build({});
    expect(built.settings).toBeUndefined();
    expect("settings" in built).toBe(false);
  });
});
