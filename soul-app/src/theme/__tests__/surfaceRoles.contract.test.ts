import fs from 'node:fs';
import path from 'node:path';
import type { DesignTokens } from '../tokens';
import { DARK_COLORS, LIGHT_COLORS } from '../tokens';
import {
  SURFACE_ROLE_NAMES,
  createSurfaceRoles,
} from '../surfaceRoles';

const SRC_ROOT = path.resolve(__dirname, '../..');

const ACTIVE_CANVAS_FILES = [
  'navigation/TabNavigator.tsx',
  'screens/DailyPlannerScreen.tsx',
  'screens/StarredFoldersScreen.tsx',
  'screens/ProjectListScreen.tsx',
  'screens/SessionFeedScreen.tsx',
  'screens/ChatScreen.tsx',
  'screens/SettingsScreen.tsx',
  'screens/LoginScreen.tsx',
  'components/chat/ChatBody.styles.ts',
  'components/split/ThreePaneLayout.tsx',
  'components/split/TwoPaneWithDrawer.tsx',
  'components/split/SidebarPane.tsx',
  'components/split/MainListPane.tsx',
  'components/split/ChatPane.tsx',
  'components/planner/FolderWorkspace.tsx',
  'components/planner/FolderWorkspaceReadOverlay.tsx',
  'components/planner/SessionSuccessionSheet.tsx',
] as const;

const ROOT_BACKGROUND_EXCEPTIONS = {} as const;

const HIGH_DENSITY_TOKEN_SURFACES = [
  'components/events/AssistantMessage.tsx',
  'components/events/UserMessage.tsx',
  'components/events/ToolEvent.tsx',
  'components/events/ThinkingEvent.tsx',
  'components/events/SystemEvent.tsx',
] as const;

const GLASS_CARD_SURFACES = [
  'components/SessionCardView.tsx',
  'components/planner/GroupedGlassSheet.tsx',
  'components/planner/DailyMemo.tsx',
  'components/planner/ProjectContextEditorView.tsx',
  'components/planner/FolderWorkspace.tsx',
  'components/split/SidebarPane.tsx',
] as const;

const MODAL_SURFACES = [
  'components/planner/MorningReviewSheet.tsx',
  'components/planner/NewFolderSheet.tsx',
  'components/planner/SessionSuccessionDiagnosticFallback.tsx',
  'components/planner/SessionSuccessionSheet.tsx',
  'components/settings/SettingsModal.tsx',
  'components/chat/ClaudeRuntimeTasksStrip.tsx',
] as const;

const CUSTOM_OVERLAY_SURFACES = [
  'components/planner/MorningReviewSheet.tsx',
] as const;

const NATIVE_SHEET_SURFACES = [
  'components/planner/NewFolderSheet.tsx',
  'components/planner/SessionSuccessionDiagnosticFallback.tsx',
  'components/planner/SessionSuccessionSheet.tsx',
  'components/settings/SettingsModal.tsx',
  'components/chat/ClaudeRuntimeTasksStrip.tsx',
] as const;

const FRAMELESS_REGIONS = [
  'components/split/ChatPane.tsx',
  'components/split/MainListPane.tsx',
  'components/split/SidebarPane.tsx',
  'components/chat/ChatBody.styles.ts',
  'components/planner/FolderWorkspaceReadOverlay.tsx',
] as const;

describe('surface role contract', () => {
  const semanticGlassExact = {
    light: {
      glassSoft: {
        translucent: 'rgba(231, 237, 245, 0.56)',
        solid: '#e7edf5',
      },
      glassCard: {
        translucent: 'rgba(224, 232, 242, 0.64)',
        solid: '#e0e8f2',
      },
      glassDense: {
        translucent: 'rgba(216, 227, 238, 0.76)',
        solid: '#d8e3ee',
      },
      stroke: 'rgba(0, 0, 0, 0.1)',
    },
    dark: {
      glassSoft: {
        translucent: 'rgba(15, 17, 21, 0.56)',
        solid: '#0f1115',
      },
      glassCard: {
        translucent: 'rgba(13, 16, 23, 0.64)',
        solid: '#0d1017',
      },
      glassDense: {
        translucent: 'rgba(11, 14, 21, 0.76)',
        solid: '#0b0e15',
      },
      stroke: 'rgba(255, 255, 255, 0.12)',
    },
  } as const;

  test.each(['light', 'dark'] as const)('%s 역할은 한 정본에서 7종을 제공한다', (mode) => {
    const roles = createSurfaceRoles(tokens(mode));

    expect(Object.keys(roles)).toEqual(SURFACE_ROLE_NAMES);
    expect(roles.canvas.tokenStyle.backgroundColor).toBe('transparent');
    expect(roles.canvas.nativeGlass).toBe(false);
    expect(roles.chrome.nativeGlass).toBe(true);
    expect(roles.glassSoft.nativeGlass).toBe(true);
    expect(roles.glassCard.nativeGlass).toBe(true);
    expect(roles.glassDense.nativeGlass).toBe(true);
    expect(roles.modal.nativeGlass).toBe(true);
    expect(roles.modal.compositesBackdrop).toBe(true);
    expect(roles.nativeSheet.nativeGlass).toBe(false);
    expect(roles.nativeSheet.compositesBackdrop).toBe(false);
    expect(roles.nativeSheet.fallbackColor).toBe(
      mode === 'light' ? LIGHT_COLORS.surface : DARK_COLORS.surface,
    );
    expect(roles.nativeSheet.borderRadius).toBe(0);
    expect(roles.nativeSheet.blurIntensity).toBe(0);
    expect(roles.nativeSheet.materialStyle).toEqual({
      native: {},
      blur: {},
      solid: {},
    });
    for (const name of ['glassSoft', 'glassCard', 'glassDense'] as const) {
      const expected = semanticGlassExact[mode][name];
      expect(roles[name].nativeTintColor).toBe(expected.translucent);
      expect(roles[name].blurColor).toBe(expected.translucent);
      expect(roles[name].fallbackColor).toBe(expected.solid);
    }
    expect(roles.glassSoft.materialStyle.native).toEqual({});
    expect(roles.glassCard.materialStyle.native).toEqual({});
    expect(roles.glassSoft.materialStyle.blur.borderColor).toBe(semanticGlassExact[mode].stroke);
    expect(roles.glassCard.materialStyle.blur.borderColor).toBe(semanticGlassExact[mode].stroke);
    expect(roles.glassSoft.materialStyle.solid.borderColor).toBe(
      mode === 'light' ? LIGHT_COLORS.border : DARK_COLORS.border,
    );
    expect(roles.glassCard.materialStyle.solid.borderColor).toBe(
      mode === 'light' ? LIGHT_COLORS.border : DARK_COLORS.border,
    );
    expect(roles.glassDense.materialStyle.blur.borderColor).toBeUndefined();
    expect(roles.modal.nativeTintColor).toBe(semanticGlassExact[mode].glassSoft.translucent);
    expect(roles.modal.blurColor).toBe(semanticGlassExact[mode].glassSoft.translucent);
    expect(roles.modal.fallbackColor).toBe(semanticGlassExact[mode].glassSoft.solid);
    expect(roles.modal.materialStyle.native).toEqual({});
    expect(roles.modal.materialStyle.blur.borderColor).toBe(semanticGlassExact[mode].stroke);
  });

  test('iPad 세 패널은 공통 panel surface를 쓰고 제목 바만 glass로 감싸지 않는다', () => {
    const panel = read('components/split/SplitPanelSurface.tsx');
    expect(panel).toContain('role="glassSoft"');
    expect(read('components/split/ThreePaneLayout.tsx')).toContain('<SplitPanelSurface');
    expect(read('components/split/TwoPaneWithDrawer.tsx')).toContain('<SplitPanelSurface');
    expect(read('components/split/MainListPane.tsx')).not.toContain('<GlassSurface');
    expect(read('components/split/SidebarPane.tsx')).not.toContain('<GlassSurface');
  });

  test.each(ACTIVE_CANVAS_FILES)('%s의 전체 화면 root는 background token으로 wallpaper를 덮지 않는다', (file) => {
    const source = read(file);
    expect(source).not.toMatch(
      /backgroundColor:\s*(?:c|t\.colors|colors)\.background/,
    );
  });

  test('bottom-tabs scene layer도 NavigationContainer 배경을 투과한다', () => {
    expect(read('navigation/TabNavigator.tsx')).toMatch(
      /sceneStyle:\s*\{\s*backgroundColor:\s*['"]transparent['"]\s*\}/,
    );
  });

  test('세션 피드는 제한된 window의 FlatList로 card glass 마운트를 제한한다', () => {
    const source = read('screens/SessionFeedScreen.tsx');
    expect(source).toContain('<FlatList');
    expect(source).toContain('SESSION_FEED_VIRTUALIZATION');
  });

  test('삭제된 legacy 화면 때문에 불투명 root 예외를 남기지 않는다', () => {
    expect(Object.entries(ROOT_BACKGROUND_EXCEPTIONS)).toEqual([]);
  });

  test.each(HIGH_DENSITY_TOKEN_SURFACES)('%s 고밀도 채팅 이벤트 행은 native glass를 만들지 않는다', (file) => {
    const source = read(file);
    expect(source).not.toMatch(/<GlassSurface\b/);
    expect(source).not.toMatch(/<AppGlass(?:Card|Pressable)\b/);
  });

  test.each(GLASS_CARD_SURFACES)('%s 카드·행은 역할 기반 native glass 진입점을 사용한다', (file) => {
    if (file === 'components/planner/ProjectContextEditorView.tsx') {
      expect(read(file)).toContain('<PlannerForegroundCard');
      expect(read('components/planner/PlannerForegroundCard.tsx')).toMatch(/<AppGlassCard\b/);
    } else {
      expect(read(file)).toMatch(/<AppGlass(?:Card|Pressable)\b/);
    }
  });

  test('별표·폴더 목록은 공통 업무 행, 오늘은 공통 카드 행을 재사용한다', () => {
    for (const file of [
      'components/planner/StarredFolderList.tsx',
      'components/planner/FolderWorkspaceSections.tsx',
    ]) {
      expect(read(file)).toContain('<PlannerFolderRow');
      expect(read(file)).toContain('<GroupedGlassSheet');
    }
  });

  test('오늘 카드는 폴더와 같은 CardRow를 쓴다', () => {
    expect(read('screens/DailyPlannerScreen.tsx')).toContain('<TodayCards');
    expect(read('components/planner/TodayCards.tsx')).toContain('<CardRow');
    expect(read('components/planner/FolderCards.tsx')).toContain('<FolderCardList');
    expect(read('components/planner/FolderCardList.tsx')).toContain('<CardRow');
  });

  test('프로젝트 트리도 직접 glass를 만들지 않고 공통 grouped surface를 재사용한다', () => {
    const source = read('components/planner/ProjectTreeSheet.tsx');
    expect(source).toContain('<GroupedGlassSheet');
    expect(source).toContain('surface="inherited"');
    expect(source).not.toMatch(/<AppGlass(?:Card|Pressable)\b/);
  });

  test('프로젝트 탭 glass는 ScrollView 밖 root sibling 한 장으로 고정한다', () => {
    const screen = read('screens/ProjectListScreen.tsx');
    expect(screen).toContain('<AppGlassCard');
    expect(screen).toContain('role="glassCard"');
    expect(screen).toContain('testID="project-list-glass-background"');
    expect(screen.indexOf('<AppGlassCard')).toBeLessThan(screen.indexOf('<ScrollView'));
    expect(screen).toContain('onContentSizeChange');
    expect(screen).toContain('planner.pageInset');
    expect(screen).toContain('t.foundation.radius.card');
    expect(screen).not.toContain('StyleSheet.absoluteFillObject');
    expect(read('components/planner/GroupedGlassSheet.tsx')).toContain(
      "if (surface === 'inherited')",
    );
  });

  test('업무 세션 트리는 공통 SessionCard 시각 정본을 재사용한다', () => {
    expect(read('components/planner/FolderSessionHistory.tsx')).toContain('<SessionCard');
  });

  test('glassCard 역할은 AppGlassCard에서 GlassSurface 단일 경로로 전달된다', () => {
    const source = read('components/AppGlassCard.tsx');
    expect(source).not.toMatch(/mode\?:\s*['"]glass['"]\s*\|\s*['"]token['"]/);
    expect(source).not.toContain('!surface.nativeGlass');
    expect(source).toContain('role={resolveAppGlassRole(role)}');
    expect(read('theme/surfaceRoles.ts')).toContain(
      'nativeGlass: CARD_NATIVE_GLASS_ENABLED',
    );
  });

  test.each(MODAL_SURFACES)('%s는 공통 AppModalSurface만 사용한다', (file) => {
    const source = read(file);
    expect(source).toContain('<AppModalSurface');
    expect(source).not.toMatch(/<Modal\b/);
    expect(source).not.toMatch(/<AppGlassCard\b[^>]*role=["']modal["']/);
  });

  test.each(CUSTOM_OVERLAY_SURFACES)('%s는 custom dim+glass 계약을 선택한다', (file) => {
    const source = read(file);
    expect(source).toContain('variant="compact"');
    expect(source).not.toContain('presentationStyle=');
  });

  test.each(NATIVE_SHEET_SURFACES)('%s는 UIKit sheet+opaque surface 계약을 선택한다', (file) => {
    const source = read(file);
    expect(source).toContain('variant="expanded"');
    expect(source).toMatch(/presentationStyle=["'](?:pageSheet|formSheet)["']/);
  });

  test('AppModalSurface가 custom glass와 native sheet의 host·safe-area 단일 정본이다', () => {
    const source = read('components/AppModalSurface.tsx');
    expect(source).toContain('<Modal');
    expect(source).not.toContain('SurfaceRoleResetBoundary');
    expect(source).toContain('resolveAppModalPresentation');
    expect(source).toContain('role={presentation.surfaceRole}');
    expect(source).toContain('<SafeAreaView');
    expect(source).toContain("maxHeight: '60%'");
  });

  test.each(MODAL_SURFACES)('%s는 modal 안에 별도 card frame이나 header divider를 중첩하지 않는다', (file) => {
    const source = read(file);
    expect(source).not.toContain('borderBottomWidth');
  });

  test('설정 modal은 자식 surface에 flattened 문맥을 전달한다', () => {
    const modal = read('components/settings/SettingsModal.tsx');
    expect(modal).toContain('<SettingsScreen');
    expect(modal).toContain('showTitle={false}');
    expect(modal).toMatch(/<SettingsScreen\b[^>]*\bflattened\b/s);
    expect(read('screens/SettingsScreen.tsx')).toContain('flattened={flattened}');
    expect(read('components/settings/SettingsSurface.tsx')).toContain(
      'function SettingsSurface',
    );
    expect(read('components/settings/SettingsSection.tsx')).toContain(
      'flattened && styles.flattenedSurface',
    );
  });

  test.each(FRAMELESS_REGIONS)('%s는 행·헤더·입력 영역을 divider로 구획하지 않는다', (file) => {
    expect(read(file)).not.toMatch(/border(?:Top|Bottom)Width/);
  });

  test('채팅 composer는 입력부 안에 별도 frame을 중첩하지 않는다', () => {
    expect(read('components/chat/ChatBody.styles.ts')).not.toMatch(
      /composerBox:\s*\{[^}]*borderWidth/s,
    );
  });

  test('설정 modal은 자식 화면 제목을 숨겨 제목을 한 번만 표시한다', () => {
    expect(read('components/settings/SettingsModal.tsx')).toContain('showTitle={false}');
  });

  test('업무 행은 grouped outer surface 안에 새 glass를 중첩하지 않는다', () => {
    const source = read('components/planner/PlannerFolderRow.tsx');
    expect(source).not.toContain('createSurfaceRoles');
    expect(source).not.toMatch(/<AppGlass(?:Card|Pressable)/);
  });

  test('N8 상세 그룹은 N7 grouped sheet를 재사용하고 내부 카드 중첩을 만들지 않는다', () => {
    expect(read('components/planner/FolderWorkspaceDetails.tsx')).toContain('<GroupedGlassSheet');
    for (const file of [
      'components/planner/FolderWorkspaceDetails.tsx',
      'components/planner/FolderBoardContent.tsx',
    ]) {
      const source = read(file);
      expect(source).toContain('<GroupedGlassSheet');
      expect(source).not.toMatch(/<AppGlass(?:Card|Pressable)\b/);
    }
    expectCardRowSessionFrame(read('components/planner/CardRow.tsx'));
    expect(read('components/SessionCardView.tsx')).toContain('makeSessionCardStyles(t, embedded, small)');
    expect(read('components/planner/FolderWorkspace.tsx')).toContain('<AppGlassCard');
    expect(read('navigation/RootNavigator.tsx')).toMatch(/wallpaper:[\s\S]*opacity:\s*0\.42/);
  });

  test('카드 행 계약은 공통 프레임 이탈과 glass 중첩을 검출한다', () => {
    const source = read('components/planner/CardRow.tsx');
    expect(() => expectCardRowSessionFrame(source.replace('makeSessionCardStyles(t, true)', 'otherStyles(t)'))).toThrow();
    expect(() => expectCardRowSessionFrame(source.replace('<AppGlassCard ', '<AppGlassCard><AppGlassCard '))).toThrow();
  });

  test('floating task overlay는 split panel용 glassSoft 반경을 그대로 사용한다', () => {
    const source = read('components/planner/FolderWorkspaceReadOverlay.tsx');
    expect(source).toContain('role="glassSoft"');
    expect(source).toContain('testID="task-workspace-sheet-surface"');
    expect(source).not.toContain('<AppGlassCard role="modal"');
    expect(source).not.toContain('createFullHeightPanelStyle');
    expect(source).not.toContain('borderRadius: 0');
  });
});

function expectCardRowSessionFrame(source: string): void {
  expect(source).toContain('makeSessionCardStyles(t, true)');
  expect(source).toContain('style={styles.cardSurface}');
  expect(source).toContain('style={styles.card}');
  expect(source.match(/<AppGlassCard\b/g)).toHaveLength(1);
  expect(source).not.toMatch(/<PlannerForegroundCard\b/);
}

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
