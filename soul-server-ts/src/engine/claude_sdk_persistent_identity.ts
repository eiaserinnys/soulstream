import { createHash } from "node:crypto";

/**
 * 지속 Query가 실은 설정 경로와 자격의 대조용 지문.
 *
 * 격리 세션은 계정이 바뀌어도 설정 경로가 같은 sandbox로 고정되므로, 경로만
 * 비교하면 이전 계정의 토큰을 실은 CLI를 계속 쓴다. 자격은 이 CLI에 실린
 * `CLAUDE_CODE_OAUTH_TOKEN` 하나로 판정하고, 원문 토큰 대신 해시만 메모리에
 * 둔다. 이 값은 로그·이벤트·스냅샷·오류 문구에 싣지 않는다.
 */
export interface ClaudePersistentQueryIdentity {
  configDir: string | null;
  credentialFingerprint: string | null;
}

export function claudePersistentQueryIdentity(
  env: Record<string, string> | undefined,
): ClaudePersistentQueryIdentity {
  const token = env?.CLAUDE_CODE_OAUTH_TOKEN;
  return {
    configDir: env?.CLAUDE_CONFIG_DIR ?? null,
    credentialFingerprint: token !== undefined && token.length > 0
      ? createHash("sha256").update(token).digest("hex")
      : null,
  };
}

/** 지속 Query를 그대로 쓸 수 있는지: 설정 경로와 자격이 모두 같아야 한다. */
export function claudePersistentQueryIdentityMatches(
  current: ClaudePersistentQueryIdentity | null,
  next: ClaudePersistentQueryIdentity,
): boolean {
  return current !== null
    && current.configDir === next.configDir
    && current.credentialFingerprint === next.credentialFingerprint;
}
