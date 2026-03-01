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

/**
 * POST 요청용 헤더를 반환합니다.
 * 인증이 필요한 경우 Authorization 헤더를 포함합니다.
 *
 * 현재는 same-origin 환경이므로 토큰이 설정되지 않으면
 * Content-Type만 반환합니다. 추후 토큰 입력 UI가 추가되면
 * 이 함수에서 토큰을 포함하도록 확장합니다.
 */
export async function getAuthHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  const authRequired = await isAuthRequired();
  if (authRequired) {
    // TODO: 토큰 입력 UI 추가 시 여기서 토큰을 헤더에 포함
    // headers["Authorization"] = `Bearer ${token}`;
    console.warn(
      "[api] Auth required but no client-side token mechanism yet. POST requests may fail.",
    );
  }

  return headers;
}

/** 캐시 초기화 (테스트용) */
export function resetAuthCache(): void {
  cachedAuthRequired = null;
}
