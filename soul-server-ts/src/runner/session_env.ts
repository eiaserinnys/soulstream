import { IsolationPreparationPolicyError } from "./session_filesystem_errors.js";

/**
 * §11: restricted 자식 env의 base로 호스트 env에서 고르는 이름. 호스트 env 전체를
 * 복사하지 않는다. 세션에만 필요한 키(preset `${VAR}`, provider api_key_env)와
 * 계획 env additions는 이 목록 밖이어도 별도로 더해진다.
 */
export const RESTRICTED_ENV_BASE_ALLOWED_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "TZ",
  "TERM",
  "PWD",
  "TMPDIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "PNPM_HOME",
  "NVM_DIR",
  "COREPACK_HOME",
  "PLAYWRIGHT_BROWSERS_PATH",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ENABLE_TOOL_SEARCH",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "OPENCODE_CONFIG",
  "SOULSTREAM_AGENT_ID",
  "SOULSTREAM_NODE_ID",
  "SCRATCH_WORKSPACE_DIR",
  "AGENT_COMMON_FILES_DIR",
  "LOG_LEVEL",
  "WSL_DISTRO_NAME",
  "BASH_DEFAULT_TIMEOUT_MS",
] as const;

/** 접두어로 허용하는 이름. 아래 금지 조각이 든 이름은 접두어가 맞아도 뺀다. */
export const RESTRICTED_ENV_BASE_ALLOWED_PREFIXES = [
  "LC_",
  "XDG_",
  "GIT_CONFIG_",
  "npm_config_",
  "CLAUDE_CODE_",
] as const;

/**
 * 접두어로 고른 이름에서 거르는 조각. `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE` 같은
 * 설정은 남기고 `CLAUDE_CODE_MESSAGING_TOKEN` 같은 자격은 뺀다.
 */
export const RESTRICTED_ENV_BASE_PREFIX_EXCLUDED_SUBSTRINGS = [
  "TOKEN",
  "SECRET",
  "KEY",
  "PASSWORD",
  "CREDENTIAL",
] as const;

/** base 허용 목록 판정. `sessionKeys`는 그 세션에만 필요한 이름이다. */
export function isRestrictedBaseEnvKeyAllowed(
  key: string,
  sessionKeys: readonly string[] = [],
): boolean {
  if ((RESTRICTED_ENV_BASE_ALLOWED_KEYS as readonly string[]).includes(key)) return true;
  if (sessionKeys.includes(key)) return true;
  const prefixed = RESTRICTED_ENV_BASE_ALLOWED_PREFIXES.some((prefix) =>
    key.startsWith(prefix),
  );
  if (!prefixed) return false;
  // GIT_CONFIG_KEY_n·VALUE_n은 자격이 아니라 git 설정 전달 형식이다. 이 접두어를
  // 금지 조각 검사에 걸면 GIT_CONFIG_COUNT와 짝이 깨져 세션 git 설정이 실패한다.
  if (key.startsWith("GIT_CONFIG_")) return true;
  const upper = key.toUpperCase();
  return !RESTRICTED_ENV_BASE_PREFIX_EXCLUDED_SUBSTRINGS.some((part) =>
    upper.includes(part),
  );
}

/**
 * 호스트 env에서 restricted 자식 base로 넘길 키만 고른다. 값은 그대로 복사하며
 * 입력을 수정하지 않는다.
 */
export function selectRestrictedBaseEnv(
  baseEnv: Readonly<Record<string, string | undefined>>,
  sessionKeys: readonly string[] = [],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (!isRestrictedBaseEnvKeyAllowed(key, sessionKeys)) continue;
    env[key] = value;
  }
  return env;
}

/**
 * §11: host 관리 환경에서 restricted CLI로 넘기지 않는 키.
 * AUTH_BEARER_TOKEN과 TEST_DATABASE_URL은 제거 뒤 승인된 값으로 다시 넣는다.
 * 상자 밖 세션용으로 채운 TEST_DATABASE_URL도 상자 안에서는 지우고 승인값만 남긴다.
 */
export const RESTRICTED_ENV_REMOVED_KEYS = [
  "AUTH_BEARER_TOKEN",
  "DATABASE_URL",
  "TEST_DATABASE_URL",
  "SSH_AUTH_SOCK",
  "DBUS_SESSION_BUS_ADDRESS",
  "DOCKER_HOST",
  "PM2_HOME",
  "RUSTC_WRAPPER",
  "RUSTC_WORKSPACE_WRAPPER",
  "CARGO_BUILD_RUSTC_WRAPPER",
] as const;

/** host cache launcher가 남기는 접두사. 값은 읽지 않고 키만 지운다. */
export const RESTRICTED_ENV_REMOVED_KEY_PREFIXES = ["SCCACHE_"] as const;

/** §8: 세션 git이 원본 저장소를 유지보수하지 않도록 합치는 설정. */
const RESTRICTED_GIT_CONFIGURATION: readonly (readonly [string, string])[] = [
  ["gc.auto", "0"],
  ["maintenance.auto", "false"],
  ["fetch.writeCommitGraph", "false"],
];

export interface RestrictedSessionEnvInput {
  /** 원본 세션 환경. 수정하지 않는다. */
  baseEnv: Readonly<Record<string, string | undefined>>;
  /**
   * 이 세션에만 필요한 이름. 모델 preset env가 참조하는 `${VAR}`과 에이전트
   * 프로필 provider의 `api_key_env`다. base 허용 목록 밖이어도 이 이름은 넘긴다.
   */
  sessionKeys?: readonly string[];
  /** B2가 만든 세션 추가분(모델 인증, GH, ssr1, 승인 시험 DB, 캐시). */
  additions: Readonly<Record<string, string>>;
  /** 현재 세션의 ssr1. AUTH_BEARER_TOKEN 자리를 대체한다. */
  restrictedCredential: string;
  /** host full 비밀값. 다른 키에 복제되었는지 값 비교에만 쓴다. */
  fullSecrets: readonly string[];
  wsl: boolean;
}

function isRemovedKey(key: string): boolean {
  if ((RESTRICTED_ENV_REMOVED_KEYS as readonly string[]).includes(key)) return true;
  return RESTRICTED_ENV_REMOVED_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function mergeRestrictedGitConfiguration(env: Record<string, string>): void {
  const rawCount = env.GIT_CONFIG_COUNT;
  let count = 0;
  if (rawCount !== undefined && rawCount !== "") {
    const parsed = Number(rawCount);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new IsolationPreparationPolicyError("GIT_CONFIG_COUNT 형식이 잘못되었습니다");
    }
    count = parsed;
    for (let index = 0; index < count; index += 1) {
      if (env[`GIT_CONFIG_KEY_${index}`] === undefined) {
        throw new IsolationPreparationPolicyError(
          `GIT_CONFIG_KEY_${index}가 없습니다`,
        );
      }
    }
  }

  for (const [key, value] of RESTRICTED_GIT_CONFIGURATION) {
    env[`GIT_CONFIG_KEY_${count}`] = key;
    env[`GIT_CONFIG_VALUE_${count}`] = value;
    count += 1;
  }
  env.GIT_CONFIG_COUNT = String(count);
}

/**
 * §11 restricted env의 최종 경계. 원본 세션 환경에서 관리 자격을 지우고
 * 목적별 예외만 더한 뒤, full 비밀값이 다른 키로 복제되었는지 값으로 확인한다.
 * 비밀값은 오류 메시지에 넣지 않는다.
 */
export function buildRestrictedSessionEnv(
  input: RestrictedSessionEnvInput,
): Record<string, string> {
  const env = selectRestrictedBaseEnv(input.baseEnv, input.sessionKeys ?? []);
  for (const [key, value] of Object.entries(input.additions)) {
    env[key] = value;
  }

  // base와 additions를 합친 결과 전체에 §11 제거 정책을 다시 적용한다.
  // additions로 관리 자격이 되살아나지 않게 하는 경계다. 예외는 승인된
  // 시험 DB와 격리 캐시의 SCCACHE_DIR 둘이고, 둘 다 additions가 제공한 경우에만 남긴다.
  const keepsTestDatabase = Object.prototype.hasOwnProperty.call(
    input.additions,
    "TEST_DATABASE_URL",
  );
  // 노드 cargo 설정이 sccache를 걸 때 상자 안 cargo가 읽기 전용 노드 캐시 대신
  // 쓰기 가능한 격리 캐시를 쓰도록, additions가 준 SCCACHE_DIR 하나만 남긴다(카드 #1232).
  const keepsSccacheDirectory = Object.prototype.hasOwnProperty.call(
    input.additions,
    "SCCACHE_DIR",
  );
  for (const key of Object.keys(env)) {
    if (!isRemovedKey(key)) continue;
    if (key === "TEST_DATABASE_URL" && keepsTestDatabase) continue;
    if (key === "SCCACHE_DIR" && keepsSccacheDirectory) continue;
    delete env[key];
  }

  env.AUTH_BEARER_TOKEN = input.restrictedCredential;
  if (input.wsl) delete env.WSL_INTEROP;

  mergeRestrictedGitConfiguration(env);

  const forbidden = new Set(input.fullSecrets.filter((value) => value.length > 0));
  if (forbidden.has(input.restrictedCredential)) {
    throw new IsolationPreparationPolicyError(
      "restricted 자격 증명이 host full 비밀값과 같습니다",
    );
  }
  for (const [key, value] of Object.entries(env)) {
    if (!forbidden.has(value)) continue;
    throw new IsolationPreparationPolicyError(
      `환경변수 ${key}에 host full 비밀값이 복제되었습니다`,
    );
  }

  return env;
}
