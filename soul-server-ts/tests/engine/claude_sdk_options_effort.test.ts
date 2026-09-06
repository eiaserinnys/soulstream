import { describe, expect, it } from "vitest";

import { buildClaudeSdkOptions } from "../../src/engine/claude_sdk_options.js";
import type { ClaudeRunOptions } from "../../src/engine/claude_adapter.js";

/**
 * Claude ignored effort entirely before this change: the option existed on the
 * task but never reached the SDK, so a Claude session always ran at the account
 * default. These lock the hand-off to `Options.effort`, which the CLI sends as
 * `output_config.effort`.
 */
function build(options: Partial<ClaudeRunOptions>) {
  return buildClaudeSdkOptions({
    options: {
      prompt: "hi",
      workspaceDir: "/tmp/effort-ws",
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

describe("claude sdk options effort", () => {
  it("forwards the resolved effort to the SDK", () => {
    expect(build({ effort: "xhigh" }).effort).toBe("xhigh");
    expect(build({ effort: "max" }).effort).toBe("max");
  });

  it("omits effort entirely when none was resolved", () => {
    const built = build({});
    expect(built.effort).toBeUndefined();
    expect("effort" in built).toBe(false);
  });

  it("keeps model and effort independent", () => {
    const built = build({ model: "opus", effort: "low" });
    expect(built.model).toBe("opus");
    expect(built.effort).toBe("low");
  });
});
