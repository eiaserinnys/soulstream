import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClaudeAccountService } from "../../src/claude_accounts/service.js";
import { seedPoolFromLegacyCredential } from "../../src/claude_accounts/legacy_seed.js";
import type { ClaudeAuthService } from "../../src/auth/claude_auth.js";
import { createLegacyIdentityVerifier } from "../../src/runtime/claude_login_runtime_composition.js";

const accountId = "f4639022-561c-4f8f-bffe-650af65e1899";
const credentials = '{"fakeCredential":"fixture"}';
const identity = { loggedIn: true, accountUuid: accountId, email: "test@example.com", plan: "max" };
const logger = pino({ level: "silent" });

describe("seedPoolFromLegacyCredential", () => {
  let root: string;
  let accountsDir: string;
  let legacyCredentialPath: string;
  let accounts: ClaudeAccountService;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-legacy-seed-"));
    accountsDir = path.join(root, "accounts");
    legacyCredentialPath = path.join(root, "legacy.json");
    accounts = new ClaudeAccountService({ accountsDir, homeDir: root });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("copies the legacy credential into one enabled profile without changing the source", async () => {
    fs.writeFileSync(legacyCredentialPath, credentials, { mode: 0o640 });
    const before = fs.statSync(legacyCredentialPath).mtimeMs;
    const verifyIdentity = vi.fn(async (configDir: string) => {
      expect(fs.readFileSync(path.join(configDir, ".credentials.json"), "utf8")).toBe(credentials);
      return identity;
    });
    expect(await seedPoolFromLegacyCredential({ accounts, accountsDir, legacyCredentialPath, verifyIdentity, logger })).toBe("seeded");
    expect(verifyIdentity).toHaveBeenCalledOnce();
    expect(accounts.store.readAccounts()).toMatchObject([{ id: accountId, email: identity.email, plan: identity.plan, enabled: true }]);
    const profile = path.join(accountsDir, "profiles", accountId, ".credentials.json");
    expect(fs.readFileSync(profile, "utf8")).toBe(credentials);
    expect(fs.statSync(profile).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.join(accountsDir, "pending"))).toEqual([]);
    expect(fs.readFileSync(legacyCredentialPath, "utf8")).toBe(credentials);
    expect(fs.statSync(legacyCredentialPath).mtimeMs).toBe(before);
  });

  it("seeds through a CLI status check and the shared profile lookup", async () => {
    const executable = path.join(root, "fake-claude");
    fs.writeFileSync(executable, `#!/usr/bin/env node
      const ok = process.argv.slice(2).join(" ") === "auth status --json"
        && Boolean(process.env.CLAUDE_CONFIG_DIR)
        && !process.env.CLAUDE_CODE_OAUTH_TOKEN;
      console.log(JSON.stringify({ loggedIn: ok }));
    `, { mode: 0o700 });
    fs.writeFileSync(legacyCredentialPath, JSON.stringify({ claudeAiOauth: { accessToken: "fake-access" } }));
    vi.stubEnv("CLAUDE_CODE_EXECPATH", executable);
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-inherited-token");
    const fetchProfileWithAccessToken = vi.fn(async () => ({
      success: true, data: { account: { uuid: accountId, email: identity.email }, plan: identity.plan },
    }));
    const claudeAuth = { fetchProfileWithAccessToken } as unknown as ClaudeAuthService;

    const result = await seedPoolFromLegacyCredential({
      accounts, accountsDir, legacyCredentialPath, logger,
      verifyIdentity: createLegacyIdentityVerifier(claudeAuth),
    });
    expect(result).toBe("seeded");
    expect(fetchProfileWithAccessToken).toHaveBeenCalledWith("fake-access");
    expect(accounts.store.readAccounts()).toMatchObject([{ id: accountId, enabled: true }]);
  });

  it("does not repopulate an initialized empty pool", async () => {
    fs.mkdirSync(accountsDir);
    fs.writeFileSync(path.join(accountsDir, "accounts.json"), '{"version":1,"accounts":[]}');
    fs.writeFileSync(legacyCredentialPath, credentials);
    const verifyIdentity = vi.fn();
    expect(await seedPoolFromLegacyCredential({ accounts, accountsDir, legacyCredentialPath, verifyIdentity, logger })).toBe("skipped_initialized");
    expect(fs.readdirSync(accountsDir)).toEqual(["accounts.json"]);
    expect(verifyIdentity).not.toHaveBeenCalled();
  });

  it("skips when no legacy credential exists", async () => {
    const verifyIdentity = vi.fn();
    expect(await seedPoolFromLegacyCredential({ accounts, accountsDir, legacyCredentialPath, verifyIdentity, logger })).toBe("skipped_no_legacy");
    expect(fs.existsSync(accountsDir)).toBe(false);
    expect(verifyIdentity).not.toHaveBeenCalled();
  });

  it.each(["logged out", "missing UUID", "exception"])("retires the pending profile on %s", async (failure) => {
    fs.writeFileSync(legacyCredentialPath, credentials);
    const verifyIdentity = vi.fn(async () => {
      if (failure === "exception") throw new Error("verification failure");
      return { ...identity, loggedIn: failure !== "logged out", accountUuid: failure === "missing UUID" ? null : accountId };
    });
    expect(await seedPoolFromLegacyCredential({ accounts, accountsDir, legacyCredentialPath, verifyIdentity, logger })).toBe("failed");
    expect(fs.existsSync(path.join(accountsDir, "accounts.json"))).toBe(false);
    expect(fs.readdirSync(path.join(accountsDir, "pending"))).toEqual([]);
  });
});
