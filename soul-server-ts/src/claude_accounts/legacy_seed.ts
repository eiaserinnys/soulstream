import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";

import type { ParsedAuthStatus } from "./login_cli_helpers.js";
import type { ClaudeAccountService } from "./service.js";

export async function seedPoolFromLegacyCredential(deps: {
  accounts: Pick<ClaudeAccountService, "createPendingDir" | "registerFromPending" | "retirePending">;
  accountsDir: string;
  legacyCredentialPath: string;
  verifyIdentity: (configDir: string) => Promise<ParsedAuthStatus>;
  logger: Logger;
}): Promise<"seeded" | "skipped_initialized" | "skipped_no_legacy" | "failed"> {
  let loginId: string | undefined;
  try {
    if (existsSync(join(deps.accountsDir, "accounts.json"))) return "skipped_initialized";
    if (!existsSync(deps.legacyCredentialPath)) {
      deps.logger.info("Claude account pool seed skipped: no legacy credential");
      return "skipped_no_legacy";
    }
    loginId = `legacy-seed-${randomUUID()}`;
    const pendingDir = await deps.accounts.createPendingDir(loginId);
    const credentialPath = join(pendingDir, ".credentials.json");
    await copyFile(deps.legacyCredentialPath, credentialPath);
    await chmod(credentialPath, 0o600);
    const identity = await deps.verifyIdentity(pendingDir);
    if (!identity.loggedIn || !identity.accountUuid) throw new Error("Identity verification failed");
    await deps.accounts.registerFromPending({
      loginId, id: identity.accountUuid, email: identity.email, plan: identity.plan,
    });
    deps.logger.info({ accountId: identity.accountUuid }, "Claude account pool seeded from legacy login");
    return "seeded";
  } catch {
    if (loginId) {
      try {
        await deps.accounts.retirePending(loginId);
      } catch {
        deps.logger.warn("Failed to retire legacy seed pending directory");
      }
    }
    deps.logger.warn("Claude account pool legacy seed failed");
    return "failed";
  }
}
