import type {
  ClaudeAccountAccessTokenCredential,
  ClaudeAccountAuthFailureInput,
  ClaudeAccountRejectInput,
  ClaudeAccountReleaseInput,
  ClaudeAccountSelectionExhausted,
  ClaudeAccountSelectionInput,
  ClaudeAccountSelectionResult,
} from "../claude_accounts/types.js";

/**
 * 격리 러너는 선택 응답에 접근 토큰을 받는다. 이 값은 엔진 안에서만 쓰고
 * 턴 상태·이벤트·로그·영속 설정에 남기지 않는다.
 */
export type ClaudeAccountTurnSelection = ClaudeAccountSelectionResult & {
  credential?: ClaudeAccountAccessTokenCredential;
};

export type ClaudeAccountTurnResponse =
  | ClaudeAccountTurnSelection
  | ClaudeAccountSelectionExhausted;

export type ClaudeAccountPoolTurn = ClaudeAccountTurnSelection;

export interface ClaudeAccountTurnPort {
  select(input: ClaudeAccountSelectionInput): Promise<ClaudeAccountTurnResponse>;
  reject(input: ClaudeAccountRejectInput): Promise<void>;
  reportAuthFailure(input: ClaudeAccountAuthFailureInput): Promise<void>;
  release(input: ClaudeAccountReleaseInput): Promise<void>;
  restoreActiveBinding?(input: { session_id: string; account_id: string }): Promise<void>;
}

export interface ClaudeAccountTurnState {
  turn_id: string;
  account_id: string;
  attempted_ids: string[];
  continuation_uuid: string | null;
  continuation_sent: boolean;
}

export interface ClaudeAccountTurnStatePort {
  read(): ClaudeAccountTurnState | null;
  write(state: ClaudeAccountTurnState): Promise<void>;
  clear(turnId: string): Promise<void>;
  close?(): void;
}

const CREDENTIAL_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_AUTH_TOKEN_PATH",
] as const;

const FORBIDDEN_OVERRIDE_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_AUTH_TOKEN_PATH",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

export function assertClaudeAccountPoolOverrides(
  extraEnv: Record<string, string> | undefined,
): void {
  for (const key of FORBIDDEN_OVERRIDE_ENV_KEYS) {
    if (extraEnv && Object.hasOwn(extraEnv, key)) {
      throw new Error(`Claude account pool does not allow ${key}`);
    }
  }
}

export function buildClaudeAccountPoolEnvironment(
  baseEnv: Record<string, string> | undefined,
  turn: ClaudeAccountPoolTurn,
): Record<string, string> {
  if (!turn.config_dir.trim()) {
    throw new Error("Claude account pool selection has an empty config_dir");
  }
  const env = { ...(baseEnv ?? {}) };
  for (const key of CREDENTIAL_ENV_KEYS) delete env[key];
  env.CLAUDE_CONFIG_DIR = turn.config_dir;
  if (turn.credential) {
    env.CLAUDE_CODE_OAUTH_TOKEN = turn.credential.access_token;
  }
  return env;
}
