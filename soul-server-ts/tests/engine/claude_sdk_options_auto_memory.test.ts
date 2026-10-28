import { describe, expect, it, vi } from "vitest";

import { buildClaudeSdkOptions } from "../../src/engine/claude_sdk_options.js";
import type { ClaudeRunOptions } from "../../src/engine/claude_adapter.js";

/**
 * 프로필 `claude_auto_memory_enabled: false`가 SDK `settings.autoMemoryEnabled`까지
 * 가는지, 키가 없으면 `settings` 자체가 옵션에 없는지를 고정한다.
 */
function build(
  options: Partial<ClaudeRunOptions>,
  onChildProcessClosed?: (closed: Promise<void>) => void,
) {
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
    ...(onChildProcessClosed ? { onChildProcessClosed } : {}),
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

  it("installs the tracked process hook on pool mode even off Linux", () => {
    const built = build({ trackChildExit: true });
    expect(built.spawnClaudeCodeProcess).toBeTypeOf("function");
  });

  it("observes the actual child close with the process platform set to macOS", async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    let resolveObserved!: () => void;
    const observed = new Promise<void>((resolve) => {
      resolveObserved = resolve;
    });
    const onChildProcessClosed = vi.fn((closed: Promise<void>) => {
      void closed.then(resolveObserved);
    });

    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "darwin" });
    try {
      expect(build({}).spawnClaudeCodeProcess).toBeUndefined();
      const built = build({ trackChildExit: true }, onChildProcessClosed);
      const child = built.spawnClaudeCodeProcess!({
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        cwd: process.cwd(),
        env: process.env as Record<string, string>,
      });
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", () => resolve());
      });
      await observed;
      expect(onChildProcessClosed).toHaveBeenCalledOnce();
    } finally {
      Object.defineProperty(process, "platform", platformDescriptor);
    }
  });
});
