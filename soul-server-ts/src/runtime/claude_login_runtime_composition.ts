import type { Logger } from "pino";

import type { ClaudeAuthService } from "../auth/claude_auth.js";
import type { ClaudeAccountService } from "../claude_accounts/index.js";
import { ClaudeLoginService } from "../claude_accounts/login_service.js";
import { readProfileCredentialsReadOnly } from "../claude_accounts/usage.js";

export function composeClaudeLoginService(input: {
  accounts: ClaudeAccountService;
  claudeAuth: ClaudeAuthService;
  logger: Logger;
}): ClaudeLoginService {
  return new ClaudeLoginService({
    port: input.accounts,
    logger: input.logger,
    fetchProfile: async ({ configDir }) => {
      const credentials = readProfileCredentialsReadOnly(configDir);
      if (
        !credentials ||
        (credentials.expiresAtMs !== null && credentials.expiresAtMs <= Date.now())
      ) {
        return null;
      }
      const profile = await input.claudeAuth.fetchProfileWithAccessToken(
        credentials.accessToken,
      );
      return profile.success ? profile.data : null;
    },
  });
}
