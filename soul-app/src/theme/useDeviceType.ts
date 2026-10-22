import { useContext } from 'react';
import { useWindowDimensions } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';

/**
 * 디바이스 + 방향 기반 레이아웃 모드.
 *  - 'phone': 좁은 화면(iPhone, iPad split view 좁힘) — 바닥 탭바 + 풀스크린
 *  - 'tabletPortrait': 태블릿 세로 — 2-pane (사이드바 슬라이드 + 메인 + 채팅)
 *  - 'tabletLandscape': 태블릿 가로 — 3-pane (폴더 + 메인 + 채팅) + 드래그 스플릿
 */
export type DeviceType = 'phone' | 'tabletPortrait' | 'tabletLandscape';

/**
 * Tablet 분기 임계값 (단변과 안전 영역 제외 폭 기준 pt).
 *
 * 700이 아닌 600으로 잡는 이유:
 *  - iPhone Duo 바깥 화면(5.4형)은 466×678, 678×466이라 단변이 둘 다 466이다.
 *  - 안쪽 화면(7.6형)은 669×951, 626×890, 951×669, 890×626이다.
 *    단변과 안전 영역 제외 폭이 모두 626pt 이상이라 태블릿이다.
 *  - iPhone 15 Pro Max의 최대 단변은 430pt라 여전히 phone이다.
 */
export const TABLET_BREAKPOINT = 600;
export const TWO_PANE_MIN_SAFE_WIDTH = 616;

/**
 * 디바이스 타입 + 방향을 동적으로 판정한다.
 * - useWindowDimensions로 화면 크기 변경(회전, Stage Manager, Split View)에 자동 반응
 * - shortSide < TABLET_BREAKPOINT 또는 safeWidth < TWO_PANE_MIN_SAFE_WIDTH → 'phone'
 *   (Stage Manager로 좁아진 윈도우와 좁은 안전 영역 포함)
 * - tablet인 경우 width > height → 'tabletLandscape', 아니면 'tabletPortrait'
 */
export function useDeviceType(): DeviceType {
  const { width, height } = useWindowDimensions();
  const insets = useContext(SafeAreaInsetsContext);
  const shortSide = Math.min(width, height);
  const safeWidth = width - (insets?.left ?? 0) - (insets?.right ?? 0);
  if (shortSide < TABLET_BREAKPOINT || safeWidth < TWO_PANE_MIN_SAFE_WIDTH) return 'phone';
  return width > height ? 'tabletLandscape' : 'tabletPortrait';
}

/**
 * 폰트/스페이싱 토큰 분기용 phone/tablet 매핑.
 * tokens.ts가 PHONE_BASE / TABLET_BASE를 선택할 때 사용한다.
 */
export function deviceTypeToBaseKey(type: DeviceType): 'phone' | 'tablet' {
  return type === 'phone' ? 'phone' : 'tablet';
}
