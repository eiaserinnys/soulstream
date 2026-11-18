import { describe, expect, it } from "vitest";

import { buildClaudeSdkOptions } from "../../src/engine/claude_sdk_options.js";
import type { ClaudeRunOptions } from "../../src/engine/claude_adapter.js";

function build(options: Partial<ClaudeRunOptions>) {
  return buildClaudeSdkOptions({
    options: {
      prompt: "hi",
      workspaceDir: "/tmp/background-tools-ws",
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

describe("claude sdk background tools", () => {
  it.each([
    ["unspecified", {}, ["Monitor"]],
    ["other tool", { disallowedTools: ["WebFetch"] }, ["WebFetch", "Monitor"]],
    ["empty list", { disallowedTools: [] }, ["Monitor"]],
    ["already blocked", { disallowedTools: ["Monitor", "WebFetch"] }, ["Monitor", "WebFetch"]],
  ])("always blocks Monitor with %s", (_name, options, expected) => {
    expect(build(options).disallowedTools).toEqual(expected);
  });
});
