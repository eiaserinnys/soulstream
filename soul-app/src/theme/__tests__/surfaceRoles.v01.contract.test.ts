import fs from 'node:fs';
import path from 'node:path';
import type { DesignTokens } from '../tokens';
import { DARK_COLORS, LIGHT_COLORS } from '../tokens';
import {
  SURFACE_ROLE_NAMES,
  createSurfaceRoles,
  getSurfaceRole,
} from '../surfaceRoles';

const SRC_ROOT = path.resolve(__dirname, '../..');

describe('surface roles v0.1', () => {
  test.each(['light', 'dark'] as const)('%s canonical role은 정확히 7개다', (mode) => {
    const roles = createSurfaceRoles(tokens(mode));

    expect(Object.keys(roles)).toEqual([
      'canvas',
      'chrome',
      'glassSoft',
      'glassCard',
      'glassDense',
      'modal',
      'nativeSheet',
    ]);
    expect(SURFACE_ROLE_NAMES).toEqual(Object.keys(roles));
    expect(roles.canvas.nativeGlass).toBe(false);
    expect(roles.chrome.nativeGlass).toBe(true);
    expect(roles.glassSoft.blurIntensity).toBeGreaterThan(roles.glassDense.blurIntensity);
    expect(roles.modal.blurIntensity).toBeGreaterThan(roles.glassCard.blurIntensity);
    expect(roles.nativeSheet.nativeGlass).toBe(false);
    expect(roles.nativeSheet.fallbackColor).toBe(
      mode === 'light' ? LIGHT_COLORS.surface : DARK_COLORS.surface,
    );
  });

  test('role 누락과 unknown은 경계에서 명시적으로 실패한다', () => {
    const roles = createSurfaceRoles(tokens('dark'));
    expect(() => getSurfaceRole(roles, undefined)).toThrow('Surface role is required');
    expect(() => getSurfaceRole(roles, 'unknown')).toThrow('Unknown surface role: unknown');
  });

  test('canonical color와 호환 alias는 같은 정본을 가리킨다', () => {
    for (const colors of [DARK_COLORS, LIGHT_COLORS]) {
      expect(colors.textTertiary).toBe(colors.textMuted);
      expect(colors.danger).toBe(colors.error);
      expect(colors.textDisabled).toBeTruthy();
      expect(colors.accentTint).toBeTruthy();
      expect(colors.agentBadge).toBeTruthy();
    }
  });

  test('N8 뒤 canonical glass 역할은 6 files / 9 sites이고 두 default를 독립 검증한다', () => {
    const appGlass = read('components/AppGlassCard.tsx');
    expect(appGlass).toMatch(/function AppGlassCard\(\{\s*children,\s*role = 'glassCard'/);
    expect(appGlass).toMatch(/function AppGlassPressable\(\{\s*children,\s*role = 'glassCard'/);

    expect(read('components/split/SplitPanelSurface.tsx')).toContain('role="glassSoft"');
    expect(read('components/settings/SettingsSection.tsx')).toContain('role="glassSoft"');
    expect(read('components/split/ChatPane.tsx')).toContain('roles.glassDense');
    expect(read('components/events/AssistantMessage.tsx')).toContain('roles.glassDense');
    expect(read('components/planner/DailyMemo.tsx')).toContain('contentOnly');
    expect(read('components/planner/FolderWorkspace.styles.ts')).not.toContain('roles.glassCard');
    expect(read('components/planner/FolderWorkspaceReadOverlay.tsx')).toContain('roles.glassCard');

    const currentRoleFiles = [
      appGlass,
      read('components/split/SplitPanelSurface.tsx'),
      read('components/settings/SettingsSection.tsx'),
      read('components/split/ChatPane.tsx'),
      read('components/events/AssistantMessage.tsx'),
      read('components/planner/FolderWorkspaceReadOverlay.tsx'),
    ];
    expect(currentRoleFiles).toHaveLength(6);
    expect(currentRoleFiles.reduce((count, source) => count + (
      source.match(/(?:role\s*=\s*['"]glass(?:Soft|Card|Dense)['"]|roles\.glass(?:Soft|Card|Dense))/g)?.length ?? 0
    ), 0)).toBe(9);

    for (const file of [
      'components/split/SplitPanelSurface.tsx',
      'components/settings/SettingsSection.tsx',
      'components/split/ChatPane.tsx',
      'components/events/AssistantMessage.tsx',
      'components/planner/FolderWorkspaceReadOverlay.tsx',
    ]) {
      expect(read(file)).not.toMatch(/(?:roles\.(?:card|message|panel)|role=["'](?:card|message|panel)["'])/);
    }
  });
});

function read(relativePath: string): string {
  return fs.readFileSync(path.join(SRC_ROOT, relativePath), 'utf8');
}

function tokens(mode: 'light' | 'dark'): DesignTokens {
  return {
    mode,
    colors: mode === 'light' ? LIGHT_COLORS : DARK_COLORS,
    radius: { sm: 8, md: 12, lg: 16 },
    foundation: {
      radius: { chip: 8, field: 14, row: 16, card: 18, panel: 24, round: 999 },
    },
  } as DesignTokens;
}
