import type { Logger } from "pino";
import type { ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Env } from "../config.js";
import type { ClaudeAuthService } from "../auth/claude_auth.js";
import type { ClaudeAccountService } from "../claude_accounts/index.js";
import { seedPoolFromLegacyCredential } from "../claude_accounts/legacy_seed.js";
import { ClaudeLoginService } from "../claude_accounts/login_service.js";
import { readProfileCredentialsReadOnly } from "../claude_accounts/usage.js";
import {
  buildSanitizedCliEnv, resolveClaudeAuthExecutable, terminateChildProcess,
  verifyLoggedInIdentity, type ChildExit, type ClaudeLoginProfileFetcher,
  type ParsedAuthStatus,
} from "../claude_accounts/login_cli_helpers.js";

export function createClaudeProfileFetcher(claudeAuth: ClaudeAuthService): ClaudeLoginProfileFetcher {
  return async ({ configDir }) => {
    const credentials = readProfileCredentialsReadOnly(configDir);
    if (!credentials || (credentials.expiresAtMs !== null && credentials.expiresAtMs <= Date.now())) {
      return null;
    }
    const profile = await claudeAuth.fetchProfileWithAccessToken(credentials.accessToken);
    return profile.success ? profile.data : null;
  };
}

export function createLegacyIdentityVerifier(claudeAuth: ClaudeAuthService): (configDir: string) => Promise<ParsedAuthStatus> {
  const fetchProfile = createClaudeProfileFetcher(claudeAuth);
  return async (configDir) => {
    let child: ChildProcess | undefined;
    let exitPromise: Promise<ChildExit> | undefined;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<ParsedAuthStatus>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve({ loggedIn: false, accountUuid: null, email: null, plan: null });
      }, 60_000);
    });
    try {
      return await Promise.race([
        verifyLoggedInIdentity({
          cli: resolveClaudeAuthExecutable(undefined, process.env),
          configDir,
          env: buildSanitizedCliEnv(process.env, configDir),
          fetchProfile,
          onSpawnStatus: (spawned, exited) => { child = spawned; exitPromise = exited; },
        }),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
      if (timedOut && child && exitPromise) {
        await terminateChildProcess(child, exitPromise, 2_000);
      }
    }
  };
}

export async function seedLegacyClaudeAccount(input: {
  env: Pick<Env, "CLAUDE_ACCOUNTS_DIR" | "CLAUDE_AUTH_TOKEN_PATH">;
  accounts: ClaudeAccountService;
  claudeAuth: ClaudeAuthService;
  logger: Logger;
}): Promise<void> {
  await seedPoolFromLegacyCredential({
    accounts: input.accounts,
    accountsDir: input.env.CLAUDE_ACCOUNTS_DIR!,
    legacyCredentialPath: input.env.CLAUDE_AUTH_TOKEN_PATH ?? join(homedir(), ".claude", ".credentials.json"),
    verifyIdentity: createLegacyIdentityVerifier(input.claudeAuth),
    logger: input.logger,
  });
}

export function composeClaudeLoginService(input: {
  accounts: ClaudeAccountService;
  claudeAuth: ClaudeAuthService;
  logger: Logger;
}): ClaudeLoginService {
  return new ClaudeLoginService({
    port: input.accounts,
    logger: input.logger,
    fetchProfile: createClaudeProfileFetcher(input.claudeAuth),
  });
}
