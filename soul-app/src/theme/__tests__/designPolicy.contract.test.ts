import fs from 'node:fs';
import path from 'node:path';
import {
  NUMERIC_ICON_SIZE_EXCEPTIONS,
  NUMERIC_SPACING_EXCEPTIONS,
  NUMERIC_TYPOGRAPHY_EXCEPTIONS,
} from '../designPolicyExceptions.fixture';

const SRC_ROOT = path.resolve(__dirname, '../..');
const VISUAL_ROOTS = ['screens', 'components', 'navigation'] as const;
const DISCLOSURE_CONSUMERS = [
  'components/settings/BackendNodeCard.tsx',
  'components/chat/ClaudeRuntimeTasksStrip.tsx',
  'components/chat/ClaudeRuntimeSchedulesStrip.tsx',
  'components/chat/ClaudeRuntimeSignalsStrip.tsx',
  'components/chat/CollapsibleCaption.tsx',
] as const;

describe('v3 design policy contract', () => {
  test('일반 UI 제목은 phone/tablet 모두 채팅 본문보다 큰 iOS pt 위계를 제공한다', () => {
    const source = read('theme/tokens.ts');

    expect(source).toMatch(/PHONE_UI_TYPOGRAPHY\s*=\s*\{\s*meta:\s*13,\s*body:\s*15,\s*rowTitle:\s*18,\s*screenTitle:\s*22,/s);
    expect(source).toMatch(/TABLET_UI_TYPOGRAPHY\s*=\s*\{\s*meta:\s*14,\s*body:\s*16,\s*rowTitle:\s*20,\s*screenTitle:\s*24,/s);
    expect(source).toMatch(/PHONE_CARD_LAYOUT\s*=\s*\{\s*gap:\s*8,\s*padding:\s*16,\s*titleSize:\s*18,/s);
    expect(source).toMatch(/TABLET_CARD_LAYOUT\s*=\s*\{\s*gap:\s*8,\s*padding:\s*16,\s*titleSize:\s*18,/s);
    expect(source).toContain('uiSpacing: DESIGN_SPACING');
    expect(source).not.toMatch(/\b(?:caption|small|medium|title|large):\s*\d/);
  });

  test('채팅은 PR-H 이전 phone/tablet 스케일과 디바이스별 간격·터치 높이를 복원한다', () => {
    const tokens = read('theme/tokens.ts');

    expect(tokens).toMatch(/PHONE_CHAT_TYPOGRAPHY\s*=\s*\{\s*meta:\s*14,\s*body:\s*17,\s*rowTitle:\s*18,\s*screenTitle:\s*22,/s);
    expect(tokens).toMatch(/TABLET_CHAT_TYPOGRAPHY\s*=\s*\{\s*meta:\s*15,\s*body:\s*18,\s*rowTitle:\s*19,\s*screenTitle:\s*23,/s);
    expect(tokens).toMatch(/TABLET_SPACING\s*=\s*\{[\s\S]*xs:\s*6,[\s\S]*sm:\s*12,[\s\S]*md:\s*16,[\s\S]*lg:\s*20,/);
    expect(tokens).toContain('TABLET_HIT_TARGET = { min: 48 }');
    expect(tokens).toMatch(/TABLET_BASE\s*=\s*\{[\s\S]*chatFontSize:\s*TABLET_CHAT_TYPOGRAPHY,[\s\S]*spacing:\s*TABLET_SPACING,[\s\S]*hitTarget:\s*TABLET_HIT_TARGET,/);
    expect(tokens).toContain('hero: 32');

    for (const file of [
      'components/chat/ChatBody.styles.ts',
      'components/events/AssistantMessage.tsx',
      'components/events/UserMessage.tsx',
      'components/events/SystemEvent.tsx',
      'components/events/ThinkingEvent.tsx',
      'components/events/ToolEvent.tsx',
    ]) {
      expect(read(file)).toContain('t.chatFontSize.');
    }
    expect(read('components/chat/ChatBody.styles.ts')).toContain('fontSize: t.iconSize.hero');
  });

  test('화면과 공용 컴포넌트는 fontSize 숫자와 legacy 단계를 직접 선언하지 않는다', () => {
    const violations = findViolations(
      /fontSize:\s*(?:-?\d|t\.fontSize\.(?:caption|small|medium|title|large|hero)\b)/,
      NUMERIC_TYPOGRAPHY_EXCEPTIONS,
    );

    expect(violations).toEqual([]);
  });

  test('화면 여백과 간격은 spacing token만 사용한다', () => {
    const violations = findViolations(
      /\b(?:gap|rowGap|columnGap|padding|paddingHorizontal|paddingVertical|paddingTop|paddingRight|paddingBottom|paddingLeft|margin|marginHorizontal|marginVertical|marginTop|marginRight|marginBottom|marginLeft):\s*[1-9]\d*(?:\.\d+)?\b/,
      NUMERIC_SPACING_EXCEPTIONS,
    );

    expect(violations).toEqual([]);
  });

  test('아이콘 크기는 역할 token만 사용한다', () => {
    const violations = findViolations(/\bsize=\{\d+(?:\.\d+)?\}/, NUMERIC_ICON_SIZE_EXCEPTIONS);

    expect(violations).toEqual([]);
  });

  test('hitSlop은 임의 숫자로 선언하지 않는다', () => {
    expect(findViolations(/\bhitSlop=\{\d+(?:\.\d+)?\}/, new Set())).toEqual([]);
  });

  test('일반 UI disclosure는 공용 컴포넌트가 맡고 원복된 채팅 이벤트만 legacy glyph를 쓴다', () => {
    const sharedPath = path.join(SRC_ROOT, 'components/DisclosureIcon.tsx');
    expect(fs.existsSync(sharedPath)).toBe(true);

    const shared = fs.existsSync(sharedPath) ? fs.readFileSync(sharedPath, 'utf8') : '';
    expect(shared).toMatch(/expanded\s*\?\s*['"]chevron-up['"]\s*:\s*['"]chevron-down['"]/);
    expect(shared).toContain('@expo/vector-icons/Ionicons');
    for (const file of DISCLOSURE_CONSUMERS) {
      expect(read(file)).toContain('<DisclosureIcon');
    }

    const localBranches = findViolations(
      /\?\s*['"]chevron-(?:up|down|forward|right)(?:-outline)?['"]|[▲▼]/,
      new Set([
        'components/DisclosureIcon.tsx',
        "components/DisclosureIcon.tsx: name={expanded ? 'chevron-up' : 'chevron-down'}",
        "components/events/ThinkingEvent.tsx: <Text style={styles.chevron}>{expanded ? '▲' : '▼'}</Text>",
        "components/events/ToolEvent.tsx: name={expanded ? 'chevron-up' : 'chevron-down'}",
      ]),
    );
    expect(localBranches).toEqual([]);
  });

  test('채팅 tool/thinking/system 행은 compact 골격과 N4 semantic tool 높이를 함께 유지한다', () => {
    const tool = read('components/events/ToolEvent.tsx');
    expect(tool).toContain('testID="tool-event-chevron"');
    expect(tool).toMatch(/wrapper:\s*\{[^}]*borderWidth:\s*1[^}]*borderColor:\s*c\.border[^}]*overflow:\s*'hidden'/s);
    expect(tool).toMatch(/header:\s*\{[^}]*paddingHorizontal:\s*sessionRoles\.chat\.tool\.paddingHorizontal[^}]*paddingVertical:\s*sessionRoles\.chat\.tool\.paddingVertical/s);
    expect(tool).toContain('const sessionRoles = createSessionVisualRoles(t)');
    expect(tool).toMatch(/header:\s*\{[^}]*minHeight:\s*sessionRoles\.chat\.tool\.visualMinHeight/s);
    expect(tool).not.toMatch(/header:\s*\{[^}]*(?:borderWidth|borderRadius):/s);
    expect(tool).not.toMatch(/body:\s*\{[^}]*(?:borderWidth|borderRadius):/s);
    expect(tool).toContain('testID="tool-event-header-touch"');
    expect(tool).toContain('testID="tool-event-row-slot"');
    expect(tool).toContain('style={styles.headerTouchOverlay}');
    expect(tool).toMatch(/wrapperCollapsed:\s*\{\s*height:\s*toolVisualHeight\s*\}/s);
    expect(tool).toContain('testID="tool-event-retry-touch"');
    expect(tool).not.toContain('hitSlop=');
    expect(tool).toContain('testID="tool-event-state-icon"');
    expect(tool).not.toContain('retryAction');

    const thinking = read('components/events/ThinkingEvent.tsx');
    expect(thinking).toContain("<Text style={styles.chevron}>{expanded ? '▲' : '▼'}</Text>");
    expect(thinking).toMatch(/wrapper:\s*\{[^}]*marginVertical:\s*3[^}]*borderWidth:\s*1[^}]*borderColor:\s*c\.borderSubtle/s);
    expect(thinking).toMatch(/header:\s*\{[^}]*minHeight:\s*t\.hitTarget\.min/s);
    expect(thinking).toContain('icon: { fontSize: t.chatFontSize.meta }');
    expect(read('components/events/SystemEvent.tsx')).toContain('fontSize: t.chatFontSize.meta');
  });

  test('공용 glass pressable은 상호작용 표면의 최소 44pt 계약을 소유한다', () => {
    const source = read('components/AppGlassCard.tsx');

    expect(source).toMatch(/minHeight:\s*t\.hitTarget\.min/);
    expect(read('theme/tokens.ts')).toContain('DESIGN_HIT_TARGET = { min: 44 }');
  });

  test('카드와 행은 정보량 기반 자연 높이를 사용하고 빈 슬롯을 금지한다', () => {
    const tokens = read('theme/tokens.ts');
    expect(tokens).not.toContain('DESIGN_CARD_HEIGHT');
    expect(tokens).not.toContain('cardHeight:');

    for (const file of [
      'components/planner/PlannerFolderRow.tsx',
      'components/SessionCardView.tsx',
      'screens/ProjectListScreen.tsx',
      'components/planner/FolderSessionHistory.tsx',
      'components/split/SidebarPane.tsx',
    ] as const) {
      expect(read(file)).not.toContain('t.cardHeight.');
    }
    expect(read('components/planner/PlannerFolderRow.tsx')).not.toContain('chipsSlot');
    expect(read('components/SessionCardView.tsx')).not.toContain('subtitleSlot');
    expect(read('components/SessionCardView.tsx')).not.toContain('callerSlot');

    const pressable = read('components/AppGlassCard.tsx');
    expect(pressable).toMatch(
      /style=\{\[\s*!interactionDisabled[\s\S]*minHeight:\s*t\.hitTarget\.min[\s\S]*contentStyle,\s*\]\}/,
    );
  });

  test('플래너 카드와 세션 카드가 각 도메인의 semantic padding 정본을 쓴다', () => {
    for (const file of [
      'components/planner/PlannerFolderRow.tsx',
      'components/planner/Card.styles.ts',
      'components/planner/FolderBoardContent.tsx',
      'components/planner/TabletMarkdownEditor.tsx',
      'components/planner/DailyMemo.tsx',
      'components/planner/ProjectContextEditorView.tsx',
      'components/planner/FolderWorkspace.styles.ts',
    ]) {
      expect(read(file)).toContain('t.cardLayout.padding');
    }
    const projectTree = read('components/planner/ProjectTreeSheet.tsx');
    expect(projectTree).toContain('paddingHorizontal: t.uiSpacing.md');
    expect(projectTree).toContain('width: planner.disclosureVisual');
    expect(read('components/sessionCardFrame.ts')).toContain('sessionRoles.feed.cardPadding');
    for (const file of [
      'screens/ProjectListScreen.tsx',
      'components/split/SidebarPane.tsx',
      'components/planner/DailyMemo.tsx',
    ]) {
      expect(read(file)).toContain('t.cardLayout.gap');
    }
    expect(read('screens/DailyPlannerScreen.tsx')).toContain('gap: t.uiSpacing.lg');
    const groupedSheet = read('components/planner/GroupedGlassSheet.tsx');
    expect(groupedSheet).toContain('grouped.dividerColor');
    expect(read('components/planner/FolderBoardContent.tsx')).toContain('<GroupedGlassSheet');
    expect(read('components/SessionCardView.tsx')).toContain('makeSessionCardStyles(t, embedded, small)');
    expect(read('components/sessionCardFrame.ts')).toContain('t.cardLayout.gap / 2');
    expect(read('components/planner/FolderSessionHistory.tsx')).toContain('<SessionCard');
  });

  test('버튼·칩·아바타·아이콘은 역할별 크기 token을 공유한다', () => {
    const tokens = read('theme/tokens.ts');
    expect(tokens).toContain('chip: 28');
    expect(tokens).toContain('compact: 14');
    expect(tokens).toContain('message: 32');
    expect(tokens).toContain('session: 44');
    expect(read('components/sessionCardFrame.ts')).toContain('sessionRoles.feed.avatar');
    expect(read('components/events/AssistantMessage.tsx')).toContain('t.avatarSize.message');
    expect(read('components/events/UserMessage.tsx')).toContain('t.avatarSize.message');
    expect(read('components/chat/TypingIndicator.tsx')).toContain('t.avatarSize.message');
    expect(read('components/planner/PlannerFolderRow.tsx')).not.toContain('minHeight: t.controlHeight.chip');
    expect(read('components/settings/ClaudeProviderSection.tsx')).toContain('<GlassButton');
    expect(read('components/settings/ClaudeProviderSection.tsx')).toContain(
      'buttonContent: { minHeight: t.foundation.minHeight.secondary }',
    );
    expect(read('components/settings/ClaudeProviderSection.tsx')).not.toContain(
      'height: t.controlHeight.button',
    );
    expect(read('components/settings/ConnectionSettingsSection.tsx')).toContain('<GlassButton');
    expect(read('screens/SettingsScreen.styles.ts')).not.toMatch(/\bheight:\s*t\.controlHeight\.button/);
    for (const file of [
      'components/chat/ClaudeRuntimeTasksStrip.tsx',
      'components/chat/ClaudeRuntimeSignalsStrip.tsx',
    ]) expect(read(file)).not.toMatch(/(?:status|kind|modePill):\s*\{[^}]*minHeight:/s);
    expect(read('components/chat/AttachmentChips.tsx')).toContain('<CompactTouchTarget');
    expect(read('components/chat/ChatBody.styles.ts')).toMatch(
      /attachmentTouchFrame:\s*\{[^}]*minHeight:\s*t\.hitTarget\.min/s,
    );
    expect(tokens).toContain('sm: 8');
  });

  test('행 제목과 텍스트 glyph 아이콘은 각 역할 token을 실제 사용한다', () => {
    expect(read('components/sessionCardFrame.ts')).toMatch(
      /name:\s*\{[^}]*\.\.\.sessionRoles\.typography\.title/s,
    );
    for (const file of [
      'components/planner/ProjectTreeSheet.tsx',
    ]) {
      expect(read(file)).toContain('...planner.typography.cardTitle');
    }
    for (const file of [
      'components/planner/DailyMemo.tsx',
      'components/planner/PlannerSectionHeader.tsx',
    ]) {
      expect(read(file)).toContain('...planner.typography.section');
    }
    expect(read('components/planner/ProjectContextEditorView.tsx')).toContain('<PlannerSectionHeader');
    expect(read('components/planner/FolderWorkspace.tsx')).toContain('<PlannerSectionHeader');
    expect(read('components/planner/FolderWorkspace.styles.ts')).toContain('...planner.typography.navigation');
    expect(read('components/chat/ClaudeRuntimeSignalsStrip.tsx')).toMatch(
      /rowTitle:\s*\{[^}]*fontSize:\s*t\.fontSize\.body/s,
    );
    expect(read('components/DisclosureIcon.tsx')).toContain('size?: number');
    expect(read('components/DisclosureIcon.tsx')).toContain('useTokens');
    expect(read('components/chat/ChatInputRequest.styles.ts')).toContain('fontSize: t.iconSize.prominent');
    expect(read('components/chat/ChatBody.styles.ts')).toContain('fontSize: t.iconSize.hero');
    for (const file of [
      'components/planner/ProjectTreeSheet.tsx',
    ]) {
      expect(read(file)).toContain('fontSize: t.iconSize.standard');
    }
  });

  test('디자인 예외는 파일이 아니라 정확한 선언 한 줄에만 적용된다', () => {
    const fixture = read('theme/designPolicyExceptions.fixture.ts');
    const exceptions = new Set(['components/Example.tsx: fontSize: 13,']);
    expect(fixture).toContain('상대경로: 정확한 선언문');
    expect(isDeclarationException(exceptions, 'components/Example.tsx', 'fontSize: 13,')).toBe(true);
    expect(isDeclarationException(exceptions, 'components/Example.tsx', 'fontSize: 15,')).toBe(false);
    expect(isDeclarationException(exceptions, 'components/Other.tsx', 'fontSize: 13,')).toBe(false);
  });

  test('데일리 날짜·메모·카드는 같은 content column에서 시작한다', () => {
    const source = read('screens/DailyPlannerScreen.tsx');
    expect(source).toContain('testID="daily-date-row"');
    expect(source).toContain('testID="daily-centered-date"');
    expect(source).not.toContain('daily-card-summary');
    expect(source).toMatch(
      /content:\s*\{[\s\S]*paddingHorizontal:\s*t\.uiSpacing\.lg,[\s\S]*paddingVertical:\s*t\.spacing\.lg/,
    );
  });
});

function visualFiles(): string[] {
  return VISUAL_ROOTS.flatMap((root) => walk(path.join(SRC_ROOT, root)))
    .filter((file) => /\.tsx?$/.test(file))
    .filter((file) => !file.includes(`${path.sep}__tests__${path.sep}`));
}

function walk(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(entryPath) : [entryPath];
  });
}

function findViolations(pattern: RegExp, exceptions: ReadonlySet<string>): string[] {
  const violations: string[] = [];
  for (const absolutePath of visualFiles()) {
    const relativePath = path.relative(SRC_ROOT, absolutePath).replaceAll(path.sep, '/');
    const lines = fs.readFileSync(absolutePath, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (pattern.test(line) && !isDeclarationException(exceptions, relativePath, line)) {
        violations.push(`${relativePath}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  return violations;
}

function isDeclarationException(
  exceptions: ReadonlySet<string>,
  relativePath: string,
  declaration: string,
): boolean {
  return exceptions.has(`${relativePath}: ${declaration.trim()}`);
}

function read(relativePath: string): string {
  return fs.readFileSync(path.join(SRC_ROOT, relativePath), 'utf8');
}
