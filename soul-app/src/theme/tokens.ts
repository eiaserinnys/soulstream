import { useEffect, useState } from 'react';
import {
  AppState,
  Appearance as NativeAppearance,
  useColorScheme,
  type AppStateStatus,
  type ColorSchemeName,
  type DimensionValue,
  type TextStyle,
} from 'react-native';
import { useDeviceType, deviceTypeToBaseKey } from './useDeviceType';
import { useSettingsStore, type Appearance as UserAppearance } from '../store/settingsStore';
import {
  DARK_COLORS,
  LIGHT_COLORS,
  type ColorScheme,
} from './colors';

export { DARK_COLORS, LIGHT_COLORS } from './colors';
export type { ColorScheme } from './colors';

/**
 * 단일 역할 스케일 × 두 컬러 모드(dark/light)의 디자인 토큰.
 *
 * - 모든 컴포넌트는 useTokens()로 현재 모드 토큰을 받아 사용
 * - 폰/태블릿은 같은 역할 체계를 쓰되 iOS pt 가독성에 맞는 별도 크기를 사용
 * - 컬러는 DARK_COLORS / LIGHT_COLORS에 정의되며 settingsStore.appearance로 선택
 *   (system이면 OS color scheme을 따름)
 */
export interface DesignTokens {
  foundation: FoundationTokens;
  tabletShell: {
    outerInset: number;
    panelGap: number;
    header: {
      minHeight: number;
      paddingHorizontal: number;
      paddingVertical: number;
    };
    folderPane: {
      fraction: number;
      minWidth: number;
      maxWidth: number;
    };
  };
  fontSize: {
    meta: number;
    body: number;
    rowTitle: number;
    screenTitle: number;
  };
  cardLayout: {
    gap: number;
    padding: number;
    titleSize: number;
  };
  sectionTitle: {
    fontSize: number;
    lineHeight: number;
    fontWeight: TextStyle['fontWeight'];
  };
  // 채팅은 build 76 이전에 실기기에서 검증된 별도 읽기 스케일을 유지한다.
  // 웹 px 값을 iOS pt로 축소 적용하지 않는다.
  chatFontSize: {
    meta: number;
    body: number;
    rowTitle: number;
    screenTitle: number;
  };
  // 줄간격 정본 — 모든 텍스트의 `lineHeight = fontSize × lineHeightRatio` 형태로 사용.
  // 빌드 23 이전: 1.40 / 1.45 / 1.50 산재 (사용처별 갈라짐, design-principles §3 위배).
  // 1.30으로 통일하여 한 곳에서 관리한다.
  lineHeightRatio: number;
  spacing: {
    xxs: number;
    xs: number;
    sm: number;
    md: number;
    lg: number;
    xl: number;
    xxl: number;
    xxxl: number;
  };
  // 카드·목록·런타임 행의 조밀한 시각 리듬. 채팅 여백의 기기별 스케일과 분리한다.
  uiSpacing: {
    xxs: number;
    xs: number;
    sm: number;
    md: number;
    lg: number;
    xl: number;
    xxl: number;
    xxxl: number;
  };
  hitTarget: {
    min: number;
  };
  controlHeight: {
    button: number;
    chip: number;
    input: number;
    sendBtn: number;
  };
  iconSize: {
    compact: number;
    standard: number;
    prominent: number;
    hero: number;
    navigation: number;
    action: number;
  };
  avatarSize: {
    compact: number;
    message: number;
    session: number;
  };
  bubble: {
    maxWidthAssistant: DimensionValue;
    maxWidthUser: DimensionValue;
  };
  radius: {
    sm: number;
    md: number;
    lg: number;
  };
  keyboardOffset: number;
  // 어시스턴트 메시지의 좌측 아바타(32pt) + 갭(8pt) 폭 — ToolEvent 등 보조 항목을
  // 메시지 본문과 좌측 정렬 맞추기 위한 들여쓰기 양으로 사용.
  assistantBubbleIndent: number;
  colors: ColorScheme;
  // 현재 모드 — 동적 색상 분기에 사용 (예: NavigationContainer.theme).
  mode: 'light' | 'dark';
}

export interface FoundationTokens {
  pageInset: number;
  typography: typeof FOUNDATION_TYPOGRAPHY;
  radius: typeof FOUNDATION_RADIUS;
  minHeight: {
    segment: number;
    field: number;
    secondary: number;
    primary: number;
    context: number;
    row: number;
    folder: number;
    memo: number;
    tool: number;
    composer: number;
  };
  hitTarget: number;
  iconFrame: {
    compact: number;
    standard: number;
    action: number;
  };
}

export const PHONE_UI_TYPOGRAPHY = {
  meta: 13,
  body: 15,
  rowTitle: 18,
  screenTitle: 22,
} as const;

export const TABLET_UI_TYPOGRAPHY = {
  meta: 14,
  body: 16,
  rowTitle: 20,
  screenTitle: 24,
} as const;

export const PHONE_CARD_LAYOUT = {
  gap: 8,
  padding: 16,
  titleSize: 18,
} as const;

export const TABLET_CARD_LAYOUT = {
  gap: 8,
  padding: 16,
  titleSize: 18,
} as const;

export const TABLET_SECTION_TITLE = {
  fontSize: 18,
  lineHeight: 24,
  fontWeight: '700' as const,
} as const;

// 네이티브 텍스트 선택 오버레이의 하위 호환 정본.
export const DESIGN_TYPOGRAPHY = PHONE_UI_TYPOGRAPHY;

export const PHONE_CHAT_TYPOGRAPHY = {
  meta: 14,
  body: 17,
  rowTitle: 18,
  screenTitle: 22,
} as const;

export const TABLET_CHAT_TYPOGRAPHY = {
  meta: 15,
  body: 18,
  rowTitle: 19,
  screenTitle: 23,
} as const;

export const FOUNDATION_TYPOGRAPHY = {
  display: { fontSize: 28, lineHeight: 34, fontWeight: '700' },
  navigation: { fontSize: 20, lineHeight: 26, fontWeight: '600' },
  section: { fontSize: 18, lineHeight: 24, fontWeight: '700' },
  cardTitle: { fontSize: 16, lineHeight: 22, fontWeight: '600' },
  body: { fontSize: 15, lineHeight: 22, fontWeight: '400' },
  meta: { fontSize: 13, lineHeight: 18, fontWeight: '400' },
  label: { fontSize: 12, lineHeight: 16, fontWeight: '600' },
  mono: { fontSize: 13, lineHeight: 19, fontWeight: '400' },
} as const;

export const DESIGN_SPACING = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 40,
} as const;

// iPad는 웹 px/phone pt를 확대 없이 공유하지 않는다. build 76 이전에 실기기에서
// 검증된 여백을 유지해 채팅 메시지와 이벤트 행의 읽기 리듬을 복원한다.
export const TABLET_SPACING = {
  xxs: 2,
  xs: 6,
  sm: 12,
  md: 16,
  lg: 20,
  xl: 32,
  xxl: 40,
  xxxl: 48,
} as const;

export const TABLET_SHELL_LAYOUT = {
  // iPad floating panel의 바깥 여백과 pane 사이 간격은 같은 12pt 리듬을 쓴다.
  // Retina iPad에서는 24 physical px라 wallpaper 분리가 충분하면서 저장된 pane 폭을 흔들지 않는다.
  outerInset: 12,
  panelGap: 12,
  header: {
    minHeight: 60,
    paddingHorizontal: 20,
    paddingVertical: 6,
  },
  folderPane: {
    fraction: 0.46,
    minWidth: 340,
    maxWidth: 420,
  },
} as const;

export const DESIGN_ICON_SIZE = {
  compact: 14,
  standard: 18,
  prominent: 20,
  hero: 32,
  navigation: 24,
  action: 26,
} as const;

export const DESIGN_AVATAR_SIZE = {
  compact: 20,
  message: 32,
  session: 44,
} as const;

export const DESIGN_HIT_TARGET = { min: 44 } as const;
export const TABLET_HIT_TARGET = { min: 48 } as const;

export const DESIGN_CONTROL_HEIGHT = {
  button: 44,
  chip: 28,
  input: 44,
  sendBtn: 44,
} as const;

export const CONCENTRIC_RADIUS_INSET = {
  panelToCard: 6,
  cardToField: 4,
  rowToChip: 8,
} as const;

const CHIP_RADIUS = 8;
const FIELD_RADIUS = 14;
const ROW_RADIUS = CHIP_RADIUS + CONCENTRIC_RADIUS_INSET.rowToChip;
const CARD_RADIUS = FIELD_RADIUS + CONCENTRIC_RADIUS_INSET.cardToField;

export const FOUNDATION_RADIUS = {
  chip: CHIP_RADIUS,
  field: FIELD_RADIUS,
  row: ROW_RADIUS,
  card: CARD_RADIUS,
  panel: CARD_RADIUS + CONCENTRIC_RADIUS_INSET.panelToCard,
  round: 999,
} as const;

// 기존 소비자의 단계적 이관을 위한 호환 alias. 신규 UI는 foundation.radius 역할명을 쓴다.
export const DESIGN_RADIUS = {
  sm: FOUNDATION_RADIUS.chip,
  md: 12,
  lg: FOUNDATION_RADIUS.row,
} as const;

export const FOUNDATION_MIN_HEIGHT = {
  segment: 40,
  field: 52,
  secondary: 48,
  primary: 52,
  context: 52,
  row: 64,
  folder: 80,
  memo: 112,
  tool: 40,
  composer: 56,
} as const;

const FOUNDATION_ICON_FRAME = {
  compact: 32,
  standard: 40,
} as const;

export const PHONE_FOUNDATION: FoundationTokens = {
  pageInset: 20,
  typography: FOUNDATION_TYPOGRAPHY,
  radius: FOUNDATION_RADIUS,
  minHeight: FOUNDATION_MIN_HEIGHT,
  hitTarget: DESIGN_HIT_TARGET.min,
  iconFrame: { ...FOUNDATION_ICON_FRAME, action: DESIGN_HIT_TARGET.min },
};

export const TABLET_FOUNDATION: FoundationTokens = {
  pageInset: 20,
  typography: FOUNDATION_TYPOGRAPHY,
  radius: FOUNDATION_RADIUS,
  minHeight: FOUNDATION_MIN_HEIGHT,
  hitTarget: TABLET_HIT_TARGET.min,
  iconFrame: { ...FOUNDATION_ICON_FRAME, action: TABLET_HIT_TARGET.min },
};

const SHARED_BASE = {
  tabletShell: TABLET_SHELL_LAYOUT,
  chatFontSize: PHONE_CHAT_TYPOGRAPHY,
  lineHeightRatio: 1.3,
  spacing: DESIGN_SPACING,
  uiSpacing: DESIGN_SPACING,
  controlHeight: DESIGN_CONTROL_HEIGHT,
  iconSize: DESIGN_ICON_SIZE,
  avatarSize: DESIGN_AVATAR_SIZE,
  radius: DESIGN_RADIUS,
  keyboardOffset: 0,
  assistantBubbleIndent:
    DESIGN_SPACING.md + DESIGN_AVATAR_SIZE.message + DESIGN_SPACING.sm,
};

const PHONE_BASE = {
  ...SHARED_BASE,
  foundation: PHONE_FOUNDATION,
  hitTarget: DESIGN_HIT_TARGET,
  fontSize: PHONE_UI_TYPOGRAPHY,
  cardLayout: PHONE_CARD_LAYOUT,
  sectionTitle: TABLET_SECTION_TITLE,
  bubble: {
    maxWidthAssistant: '90%' as DimensionValue,
    maxWidthUser: '80%' as DimensionValue,
  },
};

const TABLET_BASE = {
  ...SHARED_BASE,
  foundation: TABLET_FOUNDATION,
  fontSize: TABLET_UI_TYPOGRAPHY,
  cardLayout: TABLET_CARD_LAYOUT,
  sectionTitle: TABLET_SECTION_TITLE,
  chatFontSize: TABLET_CHAT_TYPOGRAPHY,
  spacing: TABLET_SPACING,
  hitTarget: TABLET_HIT_TARGET,
  assistantBubbleIndent:
    TABLET_SPACING.md + DESIGN_AVATAR_SIZE.message + DESIGN_SPACING.sm,
  bubble: {
    maxWidthAssistant: 640 as DimensionValue,
    maxWidthUser: 560 as DimensionValue,
  },
};

/**
 * 현재 디바이스 + 색상 모드에 해당하는 디자인 토큰을 반환한다.
 * - useWindowDimensions 기반이라 회전·Stage Manager 변경 시 자동 재렌더링.
 * - settingsStore.appearance가 'system'이면 OS color scheme을 따른다.
 */
export function useTokens(): DesignTokens {
  const device = useDeviceType();
  const systemScheme = useSystemColorScheme();
  const appearance = useSettingsStore((s) => s.appearance);
  const mode = resolveMode(appearance, systemScheme);
  const base = deviceTypeToBaseKey(device) === 'tablet' ? TABLET_BASE : PHONE_BASE;
  return {
    ...base,
    colors: mode === 'light' ? LIGHT_COLORS : DARK_COLORS,
    mode,
  };
}

function useSystemColorScheme(): ColorSchemeName | null {
  const observedScheme = useColorScheme();
  const [scheme, setScheme] = useState<ColorSchemeName | null>(() =>
    readNativeColorScheme(),
  );

  useEffect(() => {
    setScheme(observedScheme ?? readNativeColorScheme());
  }, [observedScheme]);

  useEffect(() => {
    let wasBackgrounded = isBackgroundAppState(AppState.currentState);
    const sub = AppState.addEventListener('change', (nextState) => {
      if (isBackgroundAppState(nextState)) {
        wasBackgrounded = true;
        return;
      }
      if (nextState === 'active' && wasBackgrounded) {
        wasBackgrounded = false;
        setScheme(readNativeColorScheme());
      }
    });
    return () => sub.remove();
  }, []);

  return scheme;
}

function readNativeColorScheme(): ColorSchemeName | null {
  return NativeAppearance.getColorScheme() ?? null;
}

function isBackgroundAppState(state: AppStateStatus): boolean {
  return state === 'background' || state === 'inactive';
}

export function resolveMode(
  appearance: UserAppearance,
  systemScheme: ColorSchemeName | null | undefined
): 'light' | 'dark' {
  if (appearance === 'light') return 'light';
  if (appearance === 'dark') return 'dark';
  return systemScheme === 'light' ? 'light' : 'dark';
}
