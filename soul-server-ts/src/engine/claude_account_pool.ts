import type {
  ClaudeAccountRejectInput,
  ClaudeAccountReleaseInput,
  ClaudeAccountSelectionInput,
  ClaudeAccountSelectionResult,
} from "../claude_accounts/types.js";

export type ClaudeAccountPoolTurn = ClaudeAccountSelectionResult;

export interface ClaudeAccountTurnPort {
  select(input: ClaudeAccountSelectionInput): Promise<ClaudeAccountSelectionResult | null>;
  reject(input: ClaudeAccountRejectInput): Promise<void>;
  release(input: ClaudeAccountReleaseInput): Promise<void>;
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
  return env;
}
