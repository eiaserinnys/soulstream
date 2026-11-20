import type { SurfaceRoleName } from './surfaceRoles';
import { CAPSULE_RADIUS, concentricRadius, ROOT_RADIUS, type DesignTokens } from './tokens';

export const PRIMITIVE_ROLE_NAMES = [
  'card',
  'row',
  'chip',
  'buttonPrimary',
  'buttonSecondary',
  'input',
  'segment',
  'avatar',
  'iconFrame',
  'loading',
  'empty',
  'error',
] as const;

export type PrimitiveRoleName = typeof PRIMITIVE_ROLE_NAMES[number];

export interface PrimitiveRoleDefinition {
  surfaceRole: SurfaceRoleName;
  radius: number;
  padding: { horizontal: number; vertical: number };
  minHeight: number;
  backgroundColor: string;
  pressedColor: string;
  focusedColor: string;
  disabledColor: string;
  contentColor: string;
  disabledContentColor: string;
}

export type PrimitiveRoles = Record<PrimitiveRoleName, PrimitiveRoleDefinition>;

export function createPrimitiveRoles(t: DesignTokens): PrimitiveRoles {
  const base = {
    padding: { horizontal: t.spacing.md, vertical: t.spacing.sm },
    pressedColor: t.colors.accentTint,
    focusedColor: t.colors.accentTint,
    // 비활성은 바탕을 칠하지 않고 opacity로만 표시한다. 글자는 바탕 위에서 읽히도록
    // 역할이 정한다(카드 #1116, #1119).
    disabledColor: 'transparent',
    contentColor: t.colors.textPrimary,
    disabledContentColor: t.colors.textPrimary,
  };
  const neutral = {
    ...base,
    backgroundColor: 'transparent',
    focusedColor: t.colors.accent,
  };
  return {
    card: {
      ...neutral,
      surfaceRole: 'glassCard',
      radius: ROOT_RADIUS,
      minHeight: 0,
    },
    row: {
      ...neutral,
      surfaceRole: 'glassCard',
      radius: ROOT_RADIUS,
      minHeight: t.foundation.minHeight.row,
    },
    chip: {
      ...neutral,
      surfaceRole: 'glassDense',
      radius: CAPSULE_RADIUS,
      minHeight: t.controlHeight.chip,
      padding: { horizontal: t.spacing.sm, vertical: t.spacing.xs },
    },
    buttonPrimary: {
      ...base,
      surfaceRole: 'canvas',
      radius: CAPSULE_RADIUS,
      minHeight: t.foundation.minHeight.primary,
      backgroundColor: t.colors.accent,
      focusedColor: t.colors.accentText,
      contentColor: t.colors.accentText,
    },
    buttonSecondary: {
      ...neutral,
      surfaceRole: 'chrome',
      radius: CAPSULE_RADIUS,
      minHeight: t.foundation.minHeight.secondary,
    },
    input: {
      ...neutral,
      surfaceRole: 'glassDense',
      radius: concentricRadius(t.spacing.md),
      minHeight: t.foundation.minHeight.field,
    },
    segment: {
      ...neutral,
      surfaceRole: 'glassSoft',
      radius: CAPSULE_RADIUS,
      minHeight: t.foundation.minHeight.segment,
    },
    avatar: {
      ...neutral,
      surfaceRole: 'glassDense',
      radius: CAPSULE_RADIUS,
      minHeight: t.avatarSize.message,
      padding: { horizontal: 0, vertical: 0 },
    },
    iconFrame: {
      ...neutral,
      surfaceRole: 'glassDense',
      radius: CAPSULE_RADIUS,
      minHeight: t.foundation.hitTarget,
      padding: { horizontal: 0, vertical: 0 },
    },
    loading: {
      ...neutral,
      surfaceRole: 'canvas',
      radius: 0,
      minHeight: t.foundation.minHeight.row,
      contentColor: t.colors.textSecondary,
    },
    empty: {
      ...neutral,
      surfaceRole: 'canvas',
      radius: 0,
      minHeight: t.foundation.minHeight.row,
      contentColor: t.colors.textTertiary,
    },
    error: {
      ...neutral,
      surfaceRole: 'canvas',
      radius: 0,
      minHeight: t.foundation.minHeight.row,
      contentColor: t.colors.errorText,
    },
  };
}
