import type { GoogleProfile } from './jwt-payload';

/**
 * soul-app이 세션 생성 시 첨부하는 caller_info의 통합 스키마 v1 형태.
 *
 * - `source`: push notifier 화이트리스트 호환을 위해 항상 `'soul-app'` 고정
 * - `display_name` / `user_id` / `avatar_url` / `email`: Google 로그인 프로필이
 *   확인된 경우에만 포함된다. 비로그인·디코드 실패 시 source만 전송하여 서버
 *   자동 조립이 IP/UA 등 메타로 보강한다.
 *
 * `user_id`는 백엔드 JWT 구조상 Google 진짜 sub이 아닌 **email**이다 (정본:
 * `packages/soul-common/src/soul_common/auth/jwt.py:generate_token`의 `sub: email`).
 */
export interface SoulAppCallerInfo {
  source: 'soul-app';
  display_name?: string;
  user_id?: string;
  avatar_url?: string;
  email?: string;
}

/**
 * Google 프로필이 있으면 신원 필드를 채워, 없으면 source만 가진 minimal 형태로
 * caller_info를 조립한다.
 *
 * - 프로필이 null/undefined → `{ source: 'soul-app' }` (push notifier 화이트리스트
 *   호환을 위해 source는 항상 유지)
 * - 프로필이 있으면 → top-level `display_name`(=name), `user_id`(=email),
 *   `avatar_url`(=picture), `email` 추가
 *
 * 헬퍼는 zustand store나 jwt 같은 외부 상태에 직접 접근하지 않는다 — 호출자가
 * 디코드된 프로필을 명시적으로 전달한다 (design-principles §6).
 */
export function buildSoulAppCallerInfo(
  profile: GoogleProfile | null,
): SoulAppCallerInfo {
  if (!profile) {
    return { source: 'soul-app' };
  }
  return {
    source: 'soul-app',
    display_name: profile.name,
    user_id: profile.email,
    avatar_url: profile.picture,
    email: profile.email,
  };
}
