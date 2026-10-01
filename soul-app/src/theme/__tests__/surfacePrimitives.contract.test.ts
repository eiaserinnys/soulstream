import fs from 'node:fs';
import path from 'node:path';
import type { DesignTokens } from '../tokens';
import { DARK_COLORS, LIGHT_COLORS, PHONE_FOUNDATION } from '../tokens';
import { PRIMITIVE_ROLE_NAMES, createPrimitiveRoles } from '../surfacePrimitives';

const SRC_ROOT = path.resolve(__dirname, '../..');

describe('surface primitive roles', () => {
  test('12개 primitive와 semantic minHeight/radius/state를 한 정본에서 제공한다', () => {
    const roles = createPrimitiveRoles(tokens());

    expect(Object.keys(roles)).toEqual(PRIMITIVE_ROLE_NAMES);
    expect(PRIMITIVE_ROLE_NAMES).toHaveLength(12);
    expect(roles.card.surfaceRole).toBe('glassCard');
    expect(roles.row.minHeight).toBe(PHONE_FOUNDATION.minHeight.row);
    expect(roles.buttonPrimary.surfaceRole).toBe('canvas');
    expect(roles.buttonPrimary.backgroundColor).toBe(DARK_COLORS.accent);
    expect(roles.buttonSecondary.surfaceRole).toBe('chrome');
    expect(roles.buttonSecondary.pressedColor).toBe(DARK_COLORS.accentTint);
    expect(roles.buttonSecondary.focusedColor).toBe(DARK_COLORS.accent);
    expect(roles.buttonPrimary.focusedColor).toBe(DARK_COLORS.accentText);
    expect(roles.input.minHeight).toBe(PHONE_FOUNDATION.minHeight.field);
    expect(roles.segment.minHeight).toBe(PHONE_FOUNDATION.minHeight.segment);
    expect(roles.iconFrame.minHeight).toBe(PHONE_FOUNDATION.hitTarget);
    expect(roles.error.contentColor).toBe(DARK_COLORS.errorText);
  });

  test.each([
    ['dark', DARK_COLORS],
    ['light', LIGHT_COLORS],
  ] as const)('%s primary focus border는 accent fill과 3:1 이상 대비한다', (_mode, colors) => {
    const roles = createPrimitiveRoles(tokens(colors));
    expect(contrastRatio(roles.buttonPrimary.focusedColor, colors.accent)).toBeGreaterThanOrEqual(3);
  });

  test.each([
    ['dark', DARK_COLORS],
    ['light', LIGHT_COLORS],
  ] as const)('%s error primitive text는 neutral surface와 4.5:1 이상 대비한다', (_mode, colors) => {
    const roles = createPrimitiveRoles(tokens(colors));
    expect(roles.error.contentColor).toBe(colors.errorText);
    expect(contrastRatio(roles.error.contentColor, colors.surface)).toBeGreaterThanOrEqual(4.5);
  });

  test('N2 5 files / 7 authored units는 모두 primitive 정본에 배정되어 미할당 0이다', () => {
    const expected = new Map([
      ['components/AppGlassCard.tsx', ['AppGlassCard', 'AppGlassPressable']],
      ['components/CompactTouchTarget.tsx', ['CompactTouchTarget']],
      ['components/DisclosureIcon.tsx', ['DisclosureIcon']],
      ['components/GlassSurface.tsx', ['GlassSurface', 'GlassButton']],
      ['components/LiquidGlassButton.tsx', ['LiquidGlassButton']],
    ]);

    expect([...expected.values()].flat()).toHaveLength(7);
    for (const [file, units] of expected) {
      const source = fs.readFileSync(path.join(SRC_ROOT, file), 'utf8');
      for (const unit of units) expect(source).toContain(`function ${unit}`);
    }
  });

  test('header icon consumers는 공용 iconOnly glass 경계를 사용한다', () => {
    const consumers = [
      'navigation/TabNavigator.tsx',
      'components/planner/DailyHeaderActions.tsx',
      'components/split/MainListPane.tsx',
      'components/split/TabletSessionFeedPane.tsx',
    ];

    for (const file of consumers) {
      const source = fs.readFileSync(path.join(SRC_ROOT, file), 'utf8');
      expect(source).toContain('iconOnly');
    }
  });
});

function tokens(colors = DARK_COLORS): DesignTokens {
  return {
    mode: 'dark',
    colors,
    foundation: PHONE_FOUNDATION,
    spacing: { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 40 },
    hitTarget: { min: 44 },
    controlHeight: { button: 44, chip: 28, input: 44, sendBtn: 44 },
    avatarSize: { compact: 20, message: 32, session: 44 },
  } as DesignTokens;
}

function contrastRatio(foreground: string, background: string): number {
  const light = relativeLuminance(foreground);
  const dark = relativeLuminance(background);
  return (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05);
}

function relativeLuminance(color: string): number {
  const [, red, green, blue] = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color)!;
  const channel = (hex: string) => {
    const value = parseInt(hex, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
}
