import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ClaudeAuthService } from "../../src/auth/claude_auth.js";
import { createLegacyIdentityVerifier } from "../../src/runtime/claude_login_runtime_composition.js";
import { terminateChildProcess, verifyLoggedInIdentity } from "../../src/claude_accounts/login_cli_helpers.js";

vi.mock("../../src/claude_accounts/login_cli_helpers.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/claude_accounts/login_cli_helpers.js")>(),
  verifyLoggedInIdentity: vi.fn(),
  terminateChildProcess: vi.fn(),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe("legacy identity verification", () => {
  it("uses the configured CLI with a sanitized profile environment", async () => {
    vi.stubEnv("CLAUDE_CODE_EXECPATH", "/fake/claude");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token");
    const result = { loggedIn: true, accountUuid: "id", email: null, plan: null };
    vi.mocked(verifyLoggedInIdentity).mockResolvedValue(result);
    const verify = createLegacyIdentityVerifier({} as ClaudeAuthService);

    expect(await verify("/tmp/fake-profile")).toEqual(result);
    const input = vi.mocked(verifyLoggedInIdentity).mock.calls[0]![0];
    expect(input.cli).toBe("/fake/claude");
    expect(input.configDir).toBe("/tmp/fake-profile");
    expect(input.env.CLAUDE_CONFIG_DIR).toBe("/tmp/fake-profile");
    expect(input.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(input.fetchProfile).toBeTypeOf("function");
  });

  it("times out after 60 seconds and terminates the status child", async () => {
    vi.useFakeTimers();
    const child = {} as ChildProcess;
    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(() => {});
    vi.mocked(verifyLoggedInIdentity).mockImplementation(async (input) => {
      input.onSpawnStatus?.(child, exitPromise);
      return await new Promise(() => {});
    });
    vi.mocked(terminateChildProcess).mockResolvedValue();
    const result = createLegacyIdentityVerifier({} as ClaudeAuthService)("/tmp/fake-profile");

    await vi.advanceTimersByTimeAsync(60_000);
    expect(await result).toMatchObject({ loggedIn: false, accountUuid: null });
    expect(terminateChildProcess).toHaveBeenCalledWith(child, exitPromise, 2_000);
  });
});
