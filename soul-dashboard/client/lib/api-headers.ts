/**
 * API 요청 헤더 유틸리티
 *
 * DASHBOARD_AUTH_TOKEN이 서버에 설정되어 있으면
 * /api/config에서 authRequired를 확인하고 토큰을 포함합니다.
 * 개발 환경(토큰 미설정)에서는 Content-Type만 반환합니다.
 */

let cachedAuthRequired: boolean | null = null;

async function isAuthRequired(): Promise<boolean> {
  if (cachedAuthRequired !== null) return cachedAuthRequired;

  try {
    const res = await fetch("/api/config");
    if (res.ok) {
      const config = await res.json();
      cachedAuthRequired = !!config.authRequired;
    } else {
      cachedAuthRequired = false;
    }
  } catch {
    cachedAuthRequired = false;
  }

  return cachedAuthRequired;
}

/** localStorage 키: 대시보드 인증 토큰 */
const AUTH_TOKEN_KEY = "dashboard_auth_token";

/**
 * 저장된 인증 토큰을 가져옵니다.
 */
export function getStoredToken(): string | null {
  try {
    return localStorage.getItem(AUTH_TOKEN_KEY);
  } catch {
    // localStorage 접근 실패 (SSR 등)
    return null;
  }
}

/**
 * 인증 토큰을 저장합니다.
 */
export function setStoredToken(token: string): void {
  try {
    localStorage.setItem(AUTH_TOKEN_KEY, token);
  } catch {
    // localStorage 접근 실패 (SSR 등)
  }
}

/**
 * 저장된 인증 토큰을 삭제합니다.
 */
export function clearStoredToken(): void {
  try {
    localStorage.removeItem(AUTH_TOKEN_KEY);
  } catch {
    // localStorage 접근 실패 (SSR 등)
  }
}

/** 인증 필요 상태에서 토큰이 없을 때 발생하는 에러 */
export class AuthTokenRequiredError extends Error {
  constructor() {
    super(
      "Authentication required. Please set your API token in Settings.",
    );
    this.name = "AuthTokenRequiredError";
  }
}

/**
 * POST 요청용 헤더를 반환합니다.
 * 인증이 필요한 경우 Authorization 헤더를 포함합니다.
 *
 * @throws AuthTokenRequiredError 서버가 인증을 요구하지만 토큰이 설정되지 않은 경우
 */
export async function getAuthHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  const authRequired = await isAuthRequired();
  if (authRequired) {
    const token = getStoredToken();
    if (!token) {
      throw new AuthTokenRequiredError();
    }
    headers["Authorization"] = `Bearer ${token}`;
  }

  return headers;
}

/** 캐시 초기화 (테스트용) */
export function resetAuthCache(): void {
  cachedAuthRequired = null;
}
