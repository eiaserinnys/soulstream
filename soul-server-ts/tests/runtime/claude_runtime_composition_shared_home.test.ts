import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { composeClaudeAccountServices } from "../../src/runtime/claude_runtime_composition.js";

describe("Claude pool profiles' shared home", () => {
  const roots: string[] = [];
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function prepare() {
    const root = await mkdtemp(join(tmpdir(), "claude-shared-home-"));
    roots.push(root);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    vi.stubEnv("HOME", join(root, "user"));
    return root;
  }

  it("links profile history into CLAUDE_SHARED_HOME_DIR when it is set", async () => {
    const root = await prepare();
    const { claudeAccounts } = composeClaudeAccountServices({
      CLAUDE_AUTH_TOKEN_PATH: undefined,
      CLAUDE_ACCOUNT_POOL_ENABLED: true,
      CLAUDE_ACCOUNTS_DIR: join(root, "agent-home", ".claude-accounts"),
      CLAUDE_SHARED_HOME_DIR: join(root, "agent-home"),
    }, pino({ level: "silent" }));

    await claudeAccounts!.createPendingDir("login-shared-home");
    await claudeAccounts!.registerFromPending({ loginId: "login-shared-home", id: "account-1", email: null, plan: null });

    expect(existsSync(join(root, "agent-home", ".claude", "projects"))).toBe(true);
    expect(existsSync(join(root, "user", ".claude"))).toBe(false);
  });

  it("links profile history into the OS home when it is not set", async () => {
    const root = await prepare();
    const { claudeAccounts } = composeClaudeAccountServices({
      CLAUDE_AUTH_TOKEN_PATH: undefined,
      CLAUDE_ACCOUNT_POOL_ENABLED: true,
      CLAUDE_ACCOUNTS_DIR: join(root, "accounts"),
    }, pino({ level: "silent" }));

    await claudeAccounts!.createPendingDir("login-default-home");
    await claudeAccounts!.registerFromPending({ loginId: "login-default-home", id: "account-1", email: null, plan: null });

    expect(existsSync(join(root, "user", ".claude", "projects"))).toBe(true);
  });
});
