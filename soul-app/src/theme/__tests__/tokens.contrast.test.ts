import {
  DARK_COLORS,
  LIGHT_COLORS,
  resolveMode,
  type ColorScheme,
  type DesignTokens,
} from '../tokens';
import { createSurfaceRoles } from '../surfaceRoles';

function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
    throw new Error(`Unsupported hex color: ${hex}`);
  }
  return [0, 2, 4].map((offset) =>
    Number.parseInt(normalized.slice(offset, offset + 2), 16) / 255,
  ) as [number, number, number];
}

function linearize(channel: number): number {
  return channel <= 0.03928
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map(linearize);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(foreground: string, background: string): number {
  const light = Math.max(luminance(foreground), luminance(background));
  const dark = Math.min(luminance(foreground), luminance(background));
  return (light + 0.05) / (dark + 0.05);
}

function compositeRgbaOverHex(rgba: string, background: string): string {
  const match = /^rgba\((\d+), (\d+), (\d+), ([01](?:\.\d+)?)\)$/.exec(rgba);
  if (!match) throw new Error(`Unsupported rgba color: ${rgba}`);
  const foreground = match.slice(1, 4).map(Number);
  const alpha = Number(match[4]);
  const backdrop = hexToRgb(background).map((channel) => channel * 255);
  const composite = foreground.map((channel, index) =>
    Math.round(channel * alpha + backdrop[index] * (1 - alpha)));
  return `#${composite.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

function expectContrast(
  colors: ColorScheme,
  foregroundKey: keyof ColorScheme,
  backgroundKey: keyof ColorScheme,
) {
  expect(
    contrastRatio(colors[foregroundKey], colors[backgroundKey]),
  ).toBeGreaterThanOrEqual(4.5);
}

const SYSTEM_SURFACE_COLORS = {
  dark: {
    accent: '#4A9EFF',
    secondaryAction: '#555555',
    intervention: '#FF9500',
    success: '#4CAF50',
    error: '#FF5252',
    warning: '#ffb340',
    statusRunning: '#4CAF50',
    statusIdle: '#888888',
    statusCompleted: '#4A9EFF',
    statusError: '#FF5252',
  },
  light: {
    accent: '#0a84ff',
    secondaryAction: '#c7c7cc',
    intervention: '#ff9500',
    success: '#34c759',
    error: '#ff3b30',
    warning: '#ff9f0a',
    statusRunning: '#34c759',
    statusIdle: '#8e8e93',
    statusCompleted: '#0a84ff',
    statusError: '#ff3b30',
  },
} as const;

describe('theme color contrast', () => {
  const palettes = [
    ['dark', DARK_COLORS],
    ['light', LIGHT_COLORS],
  ] as const;

  it.each(palettes)('%s palette keeps body text readable', (_mode, colors) => {
    for (const background of [
      'background',
      'surface',
      'surfaceMuted',
      'surfaceCode',
    ] as const) {
      expectContrast(colors, 'textPrimary', background);
      expectContrast(colors, 'textSecondary', background);
      expectContrast(colors, 'textMuted', background);
    }
  });

  it.each(palettes)('%s palette keeps visible placeholder text readable', (_mode, colors) => {
    expectContrast(colors, 'textPlaceholder', 'background');
    expectContrast(colors, 'textPlaceholder', 'surface');
  });

  it.each([
    ['dark', DARK_COLORS, 11.32],
    ['light', LIGHT_COLORS, 6.23],
  ] as const)('%s palette keeps muted copy above the v3 policy floor', (_mode, colors, floor) => {
    for (const background of [
      'background',
      'surface',
      'surfaceMuted',
      'surfaceCode',
    ] as const) {
      expect(contrastRatio(colors.textMuted, colors[background])).toBeGreaterThanOrEqual(floor);
    }
  });

  it.each(palettes)('%s palette keeps semantic text readable on neutral surfaces', (_mode, colors) => {
    for (const foreground of ['successText', 'errorText', 'warningText', 'link'] as const) {
      expectContrast(colors, foreground, 'background');
      expectContrast(colors, foreground, 'surface');
    }
  });

  it.each(palettes)('%s palette keeps action text readable on filled controls', (_mode, colors) => {
    expectContrast(colors, 'accentText', 'accent');
    expectContrast(colors, 'accentText', 'error');
    expectContrast(colors, 'accentText', 'statusError');
    expectContrast(colors, 'accentText', 'warning');
    expectContrast(colors, 'secondaryActionText', 'secondaryAction');
    expectContrast(colors, 'interventionText', 'intervention');
  });

  it.each(palettes)('%s palette preserves system surface colors', (mode, colors) => {
    expect(colors).toMatchObject(SYSTEM_SURFACE_COLORS[mode]);
  });

  it.each(palettes)('%s role surfaces keep text readable in deterministic fallback paths', (mode, colors) => {
    const roles = createSurfaceRoles({
      mode,
      colors,
      radius: { sm: 8, md: 12, lg: 16 },
      foundation: {
        radius: { chip: 8, field: 14, row: 16, card: 18, panel: 24, round: 999 },
      },
    } as DesignTokens);
    const worstCaseWallpaper = mode === 'dark' ? '#ffffff' : '#000000';

    for (const role of ['chrome'] as const) {
      const composite = compositeRgbaOverHex(
        roles[role].tokenStyle.backgroundColor as string,
        worstCaseWallpaper,
      );
      for (const foreground of ['textPrimary', 'textSecondary', 'textMuted'] as const) {
        expect(contrastRatio(colors[foreground], composite)).toBeGreaterThanOrEqual(4.5);
      }
    }
    // Native Glass와 Blur는 backdrop을 재질 처리하므로 RGBA 단순 합성이 실제 대비를
    // 대표하지 않는다. 제품이 고정한 투명도는 surfaceRoles exact 계약이 검증하고,
    // 여기서는 Reduce Transparency가 선택하는 opaque solid 경로의 대비를 보장한다.
    for (const role of [
      'glassSoft',
      'glassCard',
      'glassDense',
      'modal',
      'nativeSheet',
    ] as const) {
      for (const foreground of ['textPrimary', 'textSecondary', 'textMuted'] as const) {
        expect(contrastRatio(colors[foreground], roles[role].fallbackColor))
          .toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe('resolveMode', () => {
  it('uses explicit appearance before the OS scheme', () => {
    expect(resolveMode('light', 'dark')).toBe('light');
    expect(resolveMode('dark', 'light')).toBe('dark');
  });

  it('follows the OS scheme in system mode', () => {
    expect(resolveMode('system', 'light')).toBe('light');
    expect(resolveMode('system', 'dark')).toBe('dark');
  });

  it('defaults system mode to dark when the OS scheme is unknown', () => {
    expect(resolveMode('system', null)).toBe('dark');
    expect(resolveMode('system', undefined)).toBe('dark');
  });
});
