import { describe, expect, it } from "vitest";

import {
  buildClaudeAccountPoolEnvironment,
  assertClaudeAccountPoolOverrides,
  type ClaudeAccountPoolTurn,
} from "../../src/engine/claude_account_pool.js";

describe("Claude account pool environment", () => {
  it("uses the selected profile and removes inherited credentials", () => {
    const env = buildClaudeAccountPoolEnvironment({
      ANTHROPIC_API_KEY: "inherited-key",
      CLAUDE_CODE_OAUTH_TOKEN: "inherited-oauth",
      ANTHROPIC_AUTH_TOKEN: "inherited-auth",
      CLAUDE_AUTH_TOKEN_PATH: "/tmp/legacy-token",
      PATH: "/usr/bin",
    }, { account_id: "account-a", config_dir: "/accounts/a" });

    expect(env).toEqual({ PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/accounts/a" });
  });

  it("rejects explicit authentication and base URL overrides for an official model", () => {
    for (const key of [
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_AUTH_TOKEN_PATH",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ]) {
      expect(() => assertClaudeAccountPoolOverrides({ [key]: "override" })).toThrow(
        `Claude account pool does not allow ${key}`,
      );
    }
  });

  it("accepts a resolved account selection as the turn binding", () => {
    const binding: ClaudeAccountPoolTurn = {
      account_id: "account-a",
      config_dir: "/accounts/a",
    };
    expect(buildClaudeAccountPoolEnvironment({}, binding).CLAUDE_CONFIG_DIR)
      .toBe("/accounts/a");
  });
});
