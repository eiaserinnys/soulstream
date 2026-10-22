import { useWindowDimensions } from 'react-native';

/**
 * 디바이스 + 방향 기반 레이아웃 모드.
 *  - 'phone': 좁은 화면(iPhone, iPad split view 좁힘) — 바닥 탭바 + 풀스크린
 *  - 'tabletPortrait': 태블릿 세로 — 2-pane (사이드바 슬라이드 + 메인 + 채팅)
 *  - 'tabletLandscape': 태블릿 가로 — 3-pane (폴더 + 메인 + 채팅) + 드래그 스플릿
 */
export type DeviceType = 'phone' | 'tabletPortrait' | 'tabletLandscape';

/**
 * Tablet 분기 임계값 (단변 기준 pt).
 *
 * 700이 아닌 600으로 잡는 이유:
 *  - iPhone Duo 바깥 화면(5.4형)은 466×678, 678×466이라 단변이 466/678이다.
 *    앞은 phone, 뒤는 tablet으로 갈라져야 하므로 경계는 466과 678 사이에 둔다.
 *  - 안쪽 화면(7.6형) 669×951, 626×890은 단변이 626/669라 모두 tablet이다.
 *  - iPhone 15 Pro Max의 최대 단변은 430pt라 여전히 phone이다.
 */
export const TABLET_BREAKPOINT = 600;

/**
 * 디바이스 타입 + 방향을 동적으로 판정한다.
 * - useWindowDimensions로 화면 크기 변경(회전, Stage Manager, Split View)에 자동 반응
 * - shortSide < TABLET_BREAKPOINT → 'phone' (Stage Manager로 좁아진 윈도우 포함)
 * - tablet인 경우 width > height → 'tabletLandscape', 아니면 'tabletPortrait'
 */
export function useDeviceType(): DeviceType {
  const { width, height } = useWindowDimensions();
  const shortSide = Math.min(width, height);
  if (shortSide < TABLET_BREAKPOINT) return 'phone';
  return width > height ? 'tabletLandscape' : 'tabletPortrait';
}

/**
 * 폰트/스페이싱 토큰 분기용 phone/tablet 매핑.
 * tokens.ts가 PHONE_BASE / TABLET_BASE를 선택할 때 사용한다.
 */
export function deviceTypeToBaseKey(type: DeviceType): 'phone' | 'tablet' {
  return type === 'phone' ? 'phone' : 'tablet';
}
