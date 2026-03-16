/**
 * 인증 모듈 공유 상수
 * middleware.ts와 routes.ts 양쪽에서 import하여 순환 의존성을 제거한다.
 */

/** JWT를 저장하는 쿠키 이름 */
export const AUTH_COOKIE_NAME = 'soul_dashboard_auth'
