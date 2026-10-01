import type { SurfaceRoleName } from './surfaceRoles';
import type { DesignTokens } from './tokens';

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
}

export type PrimitiveRoles = Record<PrimitiveRoleName, PrimitiveRoleDefinition>;

export function createPrimitiveRoles(t: DesignTokens): PrimitiveRoles {
  const base = {
    padding: { horizontal: t.spacing.md, vertical: t.spacing.sm },
    pressedColor: t.colors.accentTint,
    focusedColor: t.colors.accentTint,
    disabledColor: t.colors.textDisabled,
    contentColor: t.colors.textPrimary,
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
      radius: t.foundation.radius.card,
      minHeight: 0,
    },
    row: {
      ...neutral,
      surfaceRole: 'glassCard',
      radius: t.foundation.radius.row,
      minHeight: t.foundation.minHeight.row,
    },
    chip: {
      ...neutral,
      surfaceRole: 'glassDense',
      radius: t.foundation.radius.chip,
      minHeight: t.controlHeight.chip,
      padding: { horizontal: t.spacing.sm, vertical: t.spacing.xs },
    },
    buttonPrimary: {
      ...base,
      surfaceRole: 'canvas',
      radius: t.foundation.radius.field,
      minHeight: t.foundation.minHeight.primary,
      backgroundColor: t.colors.accent,
      focusedColor: t.colors.accentText,
      contentColor: t.colors.accentText,
    },
    buttonSecondary: {
      ...neutral,
      surfaceRole: 'chrome',
      radius: t.foundation.radius.field,
      minHeight: t.foundation.minHeight.secondary,
    },
    input: {
      ...neutral,
      surfaceRole: 'glassDense',
      radius: t.foundation.radius.field,
      minHeight: t.foundation.minHeight.field,
    },
    segment: {
      ...neutral,
      surfaceRole: 'glassSoft',
      radius: t.foundation.radius.chip,
      minHeight: t.foundation.minHeight.segment,
    },
    avatar: {
      ...neutral,
      surfaceRole: 'glassDense',
      radius: t.foundation.radius.round,
      minHeight: t.avatarSize.message,
      padding: { horizontal: 0, vertical: 0 },
    },
    iconFrame: {
      ...neutral,
      surfaceRole: 'glassDense',
      radius: t.foundation.radius.round,
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
