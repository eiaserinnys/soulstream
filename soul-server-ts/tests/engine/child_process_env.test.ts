import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import {
  BLOCKED_CHILD_PROCESS_API_KEYS,
  logBlockedChildProcessEnvKeys,
  sanitizeChildProcessEnv,
} from "../../src/engine/child_process_env.js";

describe("sanitizeChildProcessEnv", () => {
  it("always strips every billing-switch magic key and undefined values", () => {
    expect(sanitizeChildProcessEnv({
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "anthropic-must-not-leak",
      OPENAI_API_KEY: "openai-must-not-leak",
      TURN_SUMMARY_OPENAI_KEY: "summary-must-not-leak",
      MISSING: undefined,
    })).toEqual({ PATH: "/usr/bin" });
    expect(BLOCKED_CHILD_PROCESS_API_KEYS).toEqual([
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "TURN_SUMMARY_OPENAI_KEY",
    ]);
  });
});

describe("logBlockedChildProcessEnvKeys", () => {
  it("warns once with key names only when the parent environment is polluted", () => {
    const warn = vi.fn();
    const logger = { warn } as unknown as Logger;

    logBlockedChildProcessEnvKeys({
      ANTHROPIC_API_KEY: "secret-a",
      OPENAI_API_KEY: "",
      SAFE: "visible",
    }, logger);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith({
      blockedKeys: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
    }, "Blocked billing-switch API keys will be removed from child processes");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-a");
  });

  it("does not log when no blocked key exists", () => {
    const warn = vi.fn();
    logBlockedChildProcessEnvKeys(
      { PATH: "/usr/bin" },
      { warn } as unknown as Logger,
    );
    expect(warn).not.toHaveBeenCalled();
  });
});
