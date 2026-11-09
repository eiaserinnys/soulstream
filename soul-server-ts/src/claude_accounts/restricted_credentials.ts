// restricted(격리) Claude가 계정 프로필에서 접근 토큰만 꺼내는 경로.
// refreshToken과 자격 파일 원본은 밖으로 내보내지 않는다.
import type { ClaudeProfileCredentialRenewer } from "./credential_renewal.js";
import { readProfileCredentialsReadOnly } from "./usage.js";

/**
 * Claude CLI가 토큰을 스스로 갱신하는 여유와 같은 값(5분). 이 여유 안에
 * 들어온 토큰은 만료로 보고, 호스트가 미리 갱신한 뒤 다시 읽는다.
 */
export const RESTRICTED_CREDENTIAL_RENEWAL_MARGIN_MS = 5 * 60_000;

export interface RestrictedCredentialContext {
  credentialRenewer?: ClaudeProfileCredentialRenewer;
  now?: () => number;
}

export interface RestrictedCredentialInput {
  accountId: string;
  profileDir: string;
}

function needsRenewal(expiresAtMs: number | null, nowMs: number): boolean {
  if (expiresAtMs === null) return false;
  return nowMs + RESTRICTED_CREDENTIAL_RENEWAL_MARGIN_MS >= expiresAtMs;
}

/**
 * 선택된 계정의 접근 토큰. 만료(또는 갱신 여유 안)면 기존 CLI 갱신기를 한 번
 * 돌린 뒤 다시 읽어 판정한다. 갱신기는 실패해도 정상 반환하므로 호출 성공이
 * 갱신 성공을 뜻하지 않는다. 다시 읽어 실패·만료·여유 안이면 null이다.
 * 만료 시각이 없는 자격은 기존 파서 계약대로 쓸 수 있는 것으로 본다.
 */
export async function resolveRestrictedAccessToken(
  input: RestrictedCredentialInput,
  context: RestrictedCredentialContext = {},
): Promise<string | null> {
  const now = context.now ?? (() => Date.now());
  const first = readProfileCredentialsReadOnly(input.profileDir);
  if (!first) return null;
  if (!needsRenewal(first.expiresAtMs, now())) return first.accessToken;

  if (!context.credentialRenewer) return null;
  await context.credentialRenewer.renew({
    accountId: input.accountId,
    profileDir: input.profileDir,
  });

  const second = readProfileCredentialsReadOnly(input.profileDir);
  if (!second || needsRenewal(second.expiresAtMs, now())) return null;
  return second.accessToken;
}
