import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ClaudeProfileCredentialRenewer } from "../../src/claude_accounts/credential_renewal.js";
import {
  resolveRestrictedAccessToken,
  RESTRICTED_CREDENTIAL_RENEWAL_MARGIN_MS,
} from "../../src/claude_accounts/restricted_credentials.js";

const NOW_MS = Date.parse("2026-11-10T01:00:00.000Z");

describe("restricted access token resolution", () => {
  let root: string;
  let profileDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "restricted-credentials-"));
    profileDir = path.join(root, "profiles", "account-a");
    fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeCredentials(options: {
    accessToken: string;
    expiresAt: number | null;
    refreshToken?: string;
  }): void {
    const oauth: Record<string, unknown> = {
      accessToken: options.accessToken,
      refreshToken: options.refreshToken ?? "refresh-secret",
    };
    if (options.expiresAt !== null) oauth.expiresAt = options.expiresAt;
    fs.writeFileSync(
      path.join(profileDir, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: oauth }),
      { mode: 0o600 },
    );
  }

  function renewer(impl?: () => void): ClaudeProfileCredentialRenewer & { renew: ReturnType<typeof vi.fn> } {
    return {
      renew: vi.fn(async () => {
        impl?.();
      }),
    };
  }

  it("returns a usable access token without renewal and never exposes the refresh token", async () => {
    writeCredentials({ accessToken: "access-a", expiresAt: NOW_MS + 3600_000 });
    const fake = renewer();

    const token = await resolveRestrictedAccessToken(
      { accountId: "account-a", profileDir },
      { credentialRenewer: fake, now: () => NOW_MS },
    );

    expect(token).toBe("access-a");
    expect(token).not.toContain("refresh-secret");
    expect(fake.renew).not.toHaveBeenCalled();
  });

  it("renews inside the five-minute margin and reads the renewed credential", async () => {
    writeCredentials({ accessToken: "expired-a", expiresAt: NOW_MS });
    const fake = renewer(() => {
      writeCredentials({ accessToken: "renewed-a", expiresAt: NOW_MS + 3600_000 });
    });

    const token = await resolveRestrictedAccessToken(
      { accountId: "account-a", profileDir },
      { credentialRenewer: fake, now: () => NOW_MS },
    );

    expect(fake.renew).toHaveBeenCalledOnce();
    expect(fake.renew).toHaveBeenCalledWith({ accountId: "account-a", profileDir });
    expect(token).toBe("renewed-a");
  });

  it("treats the exact margin boundary as expired and stays put outside it", async () => {
    writeCredentials({
      accessToken: "boundary-a",
      expiresAt: NOW_MS + RESTRICTED_CREDENTIAL_RENEWAL_MARGIN_MS,
    });
    const boundaryRenewer = renewer(() => {
      writeCredentials({ accessToken: "boundary-renewed", expiresAt: NOW_MS + 3600_000 });
    });
    await expect(resolveRestrictedAccessToken(
      { accountId: "account-a", profileDir },
      { credentialRenewer: boundaryRenewer, now: () => NOW_MS },
    )).resolves.toBe("boundary-renewed");
    expect(boundaryRenewer.renew).toHaveBeenCalledOnce();

    writeCredentials({
      accessToken: "outside-a",
      expiresAt: NOW_MS + RESTRICTED_CREDENTIAL_RENEWAL_MARGIN_MS + 1,
    });
    const outsideRenewer = renewer();
    await expect(resolveRestrictedAccessToken(
      { accountId: "account-a", profileDir },
      { credentialRenewer: outsideRenewer, now: () => NOW_MS },
    )).resolves.toBe("outside-a");
    expect(outsideRenewer.renew).not.toHaveBeenCalled();
  });

  it("drops the candidate when the credential is missing or the renewal does not produce a usable token", async () => {
    await expect(resolveRestrictedAccessToken(
      { accountId: "account-a", profileDir },
      { now: () => NOW_MS },
    )).resolves.toBeNull();

    writeCredentials({ accessToken: "expired-a", expiresAt: NOW_MS });
    const failedRenewal = renewer();
    await expect(resolveRestrictedAccessToken(
      { accountId: "account-a", profileDir },
      { credentialRenewer: failedRenewal, now: () => NOW_MS },
    )).resolves.toBeNull();
    expect(failedRenewal.renew).toHaveBeenCalledOnce();

    const stillInsideMargin = renewer(() => {
      writeCredentials({
        accessToken: "still-expiring",
        expiresAt: NOW_MS + RESTRICTED_CREDENTIAL_RENEWAL_MARGIN_MS - 1,
      });
    });
    await expect(resolveRestrictedAccessToken(
      { accountId: "account-a", profileDir },
      { credentialRenewer: stillInsideMargin, now: () => NOW_MS },
    )).resolves.toBeNull();
  });

  it("trusts a credential without an expiry, matching the existing read-only parser", async () => {
    writeCredentials({ accessToken: "no-expiry", expiresAt: null });
    const fake = renewer();

    await expect(resolveRestrictedAccessToken(
      { accountId: "account-a", profileDir },
      { credentialRenewer: fake, now: () => NOW_MS },
    )).resolves.toBe("no-expiry");
    expect(fake.renew).not.toHaveBeenCalled();
  });
});
