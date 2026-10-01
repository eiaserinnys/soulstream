import { jwtDecode } from 'jwt-decode';

/**
 * 백엔드 발급 soul JWT의 payload 구조.
 *
 * 정본: `packages/soul-common/src/soul_common/auth/jwt.py:generate_token`
 * 발급되는 payload는 `{ sub: email, email, name, picture, exp }`이며,
 * `sub` 필드는 Google의 진짜 sub(숫자 ID)이 아닌 **email**과 동일하다.
 *
 * caller_info 통합 스키마 v1의 `user_id`는 이 payload의 `email`로 매핑한다
 * (Google sub 미보유 사실 반영).
 */
export interface SoulJwtPayload {
  sub: string;
  email: string;
  name: string;
  picture: string;
  exp: number;
}

/**
 * caller_info 신원 필드 추출에 사용하는 정규화된 Google 프로필.
 *
 * `decodeAuthJwt`가 JWT에서 추출한 결과로, name/picture 누락은 빈 문자열로 채워진다.
 * email이 누락되면 정상 프로필로 간주하지 않고 null 반환.
 */
export interface GoogleProfile {
  email: string;
  name: string;
  picture: string;
}

/**
 * `authStore.jwt`를 디코드하여 Google 프로필 필드를 추출한다.
 *
 * 입력이 null·빈 문자열이거나, 형식이 잘못되었거나, email 필드가 비어있으면
 * null을 반환하여 호출자가 caller_info 신원 필드를 생략하는 graceful fallback에
 * 사용할 수 있게 한다.
 *
 * 검증 로직은 수행하지 않는다 — 서명 검증은 백엔드의 책임이며, 클라이언트는
 * payload를 표시·식별 목적으로만 사용한다.
 */
export function decodeAuthJwt(jwt: string | null): GoogleProfile | null {
  if (!jwt) return null;
  try {
    const payload = jwtDecode<Partial<SoulJwtPayload>>(jwt);
    if (!payload.email) return null;
    return {
      email: payload.email,
      name: payload.name ?? '',
      picture: payload.picture ?? '',
    };
  } catch {
    return null;
  }
}
