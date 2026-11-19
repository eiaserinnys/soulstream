export const SCRATCH_WORKSPACE_DIR_ENV = "SCRATCH_WORKSPACE_DIR";
export const SOULSTREAM_AGENT_ID_ENV = "SOULSTREAM_AGENT_ID";
export const AGENT_COMMON_FILES_DIR_ENV = "AGENT_COMMON_FILES_DIR";

const TEST_DATABASE_URL_ENV = "TEST_DATABASE_URL";
const SESSION_ISOLATION_TEST_DATABASE_URL_ENV = "SESSION_ISOLATION_TEST_DATABASE_URL";

function isNonBlank(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

/**
 * 상자 밖(trusted 프리셋) 세션은 서버 env를 그대로 상속해 시험 DB 주소를
 * SESSION_ISOLATION_TEST_DATABASE_URL로만 본다. 같은 주소를 TEST_DATABASE_URL로도
 * 받게 채우되, 이미 있는 값은 덮지 않는다. 격리 세션은 이 뒤에 runner의
 * session_env.ts가 TEST_DATABASE_URL을 지우고 승인값으로 다시 넣으므로 영향받지
 * 않는다(카드 #1723).
 */
function fillTestDatabaseUrl(env: Record<string, string>): void {
  if (isNonBlank(env[TEST_DATABASE_URL_ENV])) return;
  const isolationUrl = env[SESSION_ISOLATION_TEST_DATABASE_URL_ENV];
  if (!isNonBlank(isolationUrl)) return;
  env[TEST_DATABASE_URL_ENV] = isolationUrl;
}

export function withScratchWorkspaceEnv(
  env: Record<string, string> | undefined,
  params: { workspaceDir: string; agentId?: string },
): Record<string, string> {
  const out: Record<string, string> = { ...(env ?? {}) };
  fillTestDatabaseUrl(out);
  out[SCRATCH_WORKSPACE_DIR_ENV] = params.workspaceDir;
  if (params.agentId !== undefined && params.agentId.trim().length > 0) {
    out[SOULSTREAM_AGENT_ID_ENV] = params.agentId;
  }
  const commonFilesDir = process.env[AGENT_COMMON_FILES_DIR_ENV];
  delete out[AGENT_COMMON_FILES_DIR_ENV];
  if (commonFilesDir !== undefined && commonFilesDir.trim().length > 0) {
    out[AGENT_COMMON_FILES_DIR_ENV] = commonFilesDir;
  }
  return out;
}
