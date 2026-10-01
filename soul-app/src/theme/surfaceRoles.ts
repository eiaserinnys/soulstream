import { StyleSheet, type ViewStyle } from 'react-native';
import type { DesignTokens } from './tokens';

export const SURFACE_ROLE_NAMES = [
  'canvas',
  'chrome',
  'glassSoft',
  'glassCard',
  'glassDense',
  'modal',
  'nativeSheet',
] as const;

export type SurfaceRoleName = typeof SURFACE_ROLE_NAMES[number];

export interface SurfaceRoleDefinition {
  compositesBackdrop: boolean;
  nativeGlass: boolean;
  nativeTintColor: string;
  blurColor: string;
  fallbackColor: string;
  borderRadius: number;
  blurIntensity: number;
  tokenStyle: ViewStyle;
  materialStyle: {
    native: ViewStyle;
    blur: ViewStyle;
    solid: ViewStyle;
  };
}

export type SurfaceRoles = Record<SurfaceRoleName, SurfaceRoleDefinition>;

const CHROME_CONTENT_ALPHA = 0.92;
const CHROME_NATIVE_TINT_ALPHA = 0.68;
const SEMANTIC_GLASS_PALETTE = {
  light: {
    glassSoft: { translucent: 'rgba(231, 237, 245, 0.56)', solid: '#e7edf5' },
    glassCard: { translucent: 'rgba(224, 232, 242, 0.64)', solid: '#e0e8f2' },
    glassDense: { translucent: 'rgba(216, 227, 238, 0.76)', solid: '#d8e3ee' },
    stroke: 'rgba(0, 0, 0, 0.1)',
  },
  dark: {
    glassSoft: { translucent: 'rgba(15, 17, 21, 0.56)', solid: '#0f1115' },
    glassCard: { translucent: 'rgba(13, 16, 23, 0.64)', solid: '#0d1017' },
    glassDense: { translucent: 'rgba(11, 14, 21, 0.76)', solid: '#0b0e15' },
    stroke: 'rgba(255, 255, 255, 0.12)',
  },
} as const;
// 실기기에서 카드 글래스를 되돌려야 할 때 바꾸는 단일 스위치.
export const CARD_NATIVE_GLASS_ENABLED = true;
export const MODAL_BACKDROP_COLOR = 'rgba(0, 0, 0, 0.35)';

/**
 * 앱 표면의 시각 역할 정본.
 *
 * 화면은 역할만 고르고 색·알파·반경을 직접 결정하지 않는다. 각 역할의 native/blur/solid
 * 분기는 GlassSurface가 맡으며, 콘텐츠 카드의 native Glass는 단일 역할 스위치로 제어한다.
 */
export function createSurfaceRoles(t: DesignTokens): SurfaceRoles {
  const c = t.colors;
  const semanticGlass = SEMANTIC_GLASS_PALETTE[t.mode];
  return {
    canvas: role({
      compositesBackdrop: false,
      nativeGlass: false,
      nativeTintColor: 'transparent',
      blurColor: 'transparent',
      fallbackColor: 'transparent',
      borderRadius: 0,
      blurIntensity: 0,
    }),
    chrome: role({
      compositesBackdrop: true,
      nativeGlass: true,
      nativeTintColor: withAlpha(c.surface, CHROME_NATIVE_TINT_ALPHA),
      blurColor: withAlpha(c.surface, CHROME_CONTENT_ALPHA),
      fallbackColor: c.surface,
      borderRadius: 0,
      blurIntensity: 74,
      blurBorderColor: withAlpha(c.border, 0.74),
      solidBorderColor: c.border,
    }),
    glassSoft: role({
      compositesBackdrop: true,
      nativeGlass: true,
      nativeTintColor: semanticGlass.glassSoft.translucent,
      blurColor: semanticGlass.glassSoft.translucent,
      fallbackColor: semanticGlass.glassSoft.solid,
      borderRadius: t.foundation.radius.panel,
      blurIntensity: 74,
      blurBorderColor: semanticGlass.stroke,
      solidBorderColor: c.border,
    }),
    glassCard: role({
      compositesBackdrop: true,
      nativeGlass: CARD_NATIVE_GLASS_ENABLED,
      nativeTintColor: semanticGlass.glassCard.translucent,
      blurColor: semanticGlass.glassCard.translucent,
      fallbackColor: semanticGlass.glassCard.solid,
      borderRadius: t.foundation.radius.card,
      blurIntensity: 62,
      blurBorderColor: semanticGlass.stroke,
      solidBorderColor: c.border,
    }),
    glassDense: role({
      compositesBackdrop: true,
      nativeGlass: true,
      nativeTintColor: semanticGlass.glassDense.translucent,
      blurColor: semanticGlass.glassDense.translucent,
      fallbackColor: semanticGlass.glassDense.solid,
      borderRadius: t.foundation.radius.field,
      blurIntensity: 48,
    }),
    modal: role({
      // 앱이 직접 dim과 겹침을 소유하는 overFullScreen 표면.
      compositesBackdrop: true,
      nativeGlass: true,
      nativeTintColor: semanticGlass.glassSoft.translucent,
      blurColor: semanticGlass.glassSoft.translucent,
      fallbackColor: semanticGlass.glassSoft.solid,
      borderRadius: t.foundation.radius.panel,
      blurIntensity: 84,
      blurBorderColor: semanticGlass.stroke,
      solidBorderColor: c.border,
    }),
    nativeSheet: role({
      // pageSheet/formSheet는 UIKit이 층과 바깥 모서리를 소유한다.
      // 앱은 그 내부를 불투명 토큰으로 채우며 별도 glass를 합성하지 않는다.
      compositesBackdrop: false,
      nativeGlass: false,
      nativeTintColor: c.surface,
      blurColor: c.surface,
      fallbackColor: c.surface,
      borderRadius: 0,
      blurIntensity: 0,
    }),
  };
}

export function getSurfaceRole(
  roles: SurfaceRoles,
  roleName: string | undefined,
): SurfaceRoleDefinition {
  if (!roleName) throw new Error('Surface role is required');
  if (!SURFACE_ROLE_NAMES.includes(roleName as SurfaceRoleName)) {
    throw new Error(`Unknown surface role: ${roleName}`);
  }
  return roles[roleName as SurfaceRoleName];
}

function role(input: {
  compositesBackdrop: boolean;
  nativeGlass: boolean;
  nativeTintColor: string;
  blurColor: string;
  fallbackColor: string;
  borderRadius: number;
  blurIntensity: number;
  blurBorderColor?: string;
  solidBorderColor?: string;
}): SurfaceRoleDefinition {
  const blurStyle: ViewStyle = input.blurBorderColor
    ? {
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: input.blurBorderColor,
      }
    : {};
  const solidStyle: ViewStyle = input.solidBorderColor
    ? {
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: input.solidBorderColor,
      }
    : {};
  return {
    compositesBackdrop: input.compositesBackdrop,
    nativeGlass: input.nativeGlass,
    nativeTintColor: input.nativeTintColor,
    blurColor: input.blurColor,
    fallbackColor: input.fallbackColor,
    borderRadius: input.borderRadius,
    blurIntensity: input.blurIntensity,
    materialStyle: {
      // Native Liquid Glass supplies refraction, highlight, and edge definition itself.
      native: {},
      // Fallback materials need a boundary because they don't lens the backdrop.
      blur: blurStyle,
      solid: solidStyle,
    },
    tokenStyle: {
      ...solidStyle,
      backgroundColor: input.blurColor,
      borderRadius: input.borderRadius,
    },
  };
}

export function withAlpha(color: string, alpha: number): string {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (!match) return color;
  const [, red, green, blue] = match;
  return `rgba(${parseInt(red, 16)}, ${parseInt(green, 16)}, ${parseInt(blue, 16)}, ${alpha})`;
}
