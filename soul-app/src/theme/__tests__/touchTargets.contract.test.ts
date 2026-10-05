import fs from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';
import React from 'react';
import { StyleSheet } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import type { Session } from '../../api/types';

let mockDeviceType: 'phone' | 'tabletPortrait' = 'phone';

jest.mock('../useDeviceType', () => ({
  useDeviceType: () => mockDeviceType,
  deviceTypeToBaseKey: (device: string) => device === 'phone' ? 'phone' : 'tablet',
}));
jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');

import { SessionCard } from '../../components/SessionCard';
import { ToolEvent } from '../../components/events/ToolEvent';
import { ClaudeRuntimeTasksStrip } from '../../components/chat/ClaudeRuntimeTasksStrip';
import { ClaudeRuntimeSignalsStrip } from '../../components/chat/ClaudeRuntimeSignalsStrip';
import { CollapsibleCaption } from '../../components/chat/CollapsibleCaption';
import { useChatStore } from '../../store/chatStore';

const SRC_ROOT = path.resolve(__dirname, '../..');
const VISUAL_ROOTS = ['screens', 'components', 'navigation'] as const;
const DIRECT_TOUCHABLES = new Set(['TouchableOpacity', 'Pressable']);

describe('direct touch target contract', () => {
  test('모든 직접 Touchable/Pressable은 hitSlop이 아닌 실제 레이아웃으로 최소 터치 영역을 보장한다', () => {
    const violations: string[] = [];

    for (const absolutePath of visualFiles()) {
      const relativePath = relative(absolutePath);
      const sourceText = fs.readFileSync(absolutePath, 'utf8');
      const sourceFile = ts.createSourceFile(
        absolutePath,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      const styles = collectStyles(sourceFile, absolutePath);

      visit(sourceFile, (node) => {
        if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return;
        const tag = node.tagName.getText(sourceFile);
        if (!DIRECT_TOUCHABLES.has(tag)) return;

        const styleAttribute = node.attributes.properties.find(
          (property): property is ts.JsxAttribute =>
            ts.isJsxAttribute(property) && property.name.getText(sourceFile) === 'style',
        );
        const styleText = styleAttribute?.initializer?.getText(sourceFile) ?? '';
        const styleNames = [...styleText.matchAll(/styles\.([A-Za-z0-9_]+)/g)].map((match) => match[1]);
        const declarations = styleNames.map((name) => styles.get(name) ?? '').join('\n');
        const touchContract = `${node.getText(sourceFile)}\n${styleText}\n${declarations}`;
        if (!hasMinimumTouchTarget(touchContract)) {
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
          violations.push(`${relativePath}:${line}: <${tag}> ${styleNames.join(',') || '(style 없음)'}`);
        }
      });
    }

    expect(violations).toEqual([]);
  });

  test.each([
    ['phone', 44],
    ['tabletPortrait', 48],
  ] as const)('%s compact control은 시각 박스와 분리된 %ipt 실제 touch frame을 렌더한다', async (
    device,
    minimum,
  ) => {
    mockDeviceType = device;
    const session = {
      agentSessionId: `session-${device}`,
      displayName: '검수 세션',
      status: 'idle',
      reviewRequired: true,
      reviewState: 'needs_review',
      createdAt: '2026-07-18T00:00:00.000Z',
      updatedAt: '2026-07-18T00:01:00.000Z',
    } satisfies Session;
    const runtimeSessionId = `runtime-${device}`;
    useChatStore.setState({
      claudeRuntimeBySession: {
        [runtimeSessionId]: {
          updatedAt: 100,
          tasks: {
            'task-1': {
              taskId: 'task-1',
              status: 'running',
              updatedAt: 100,
              taskType: 'bash',
              summary: 'long-running command',
            },
          },
          schedules: {},
          notifications: {
            'notice-1': {
              notificationId: 'notice-1',
              source: 'system',
              message: 'runtime notification',
              updatedAt: 100,
            },
          },
          remoteTriggers: {},
        },
      },
    });

    const sessionCard = render(React.createElement(SessionCard, {
      session,
      onPress: jest.fn(),
    }));
    const sessionReviewFrame = sessionCard.getByTestId('session-card-review-ack');
    const tool = render(React.createElement(ToolEvent, {
      start: { id: 'tool-1', type: 'tool_start', data: { tool_name: 'Bash' } },
    }));
    const toolHeaderFrame = tool.getByTestId('tool-event-header-touch');
    const tasks = render(React.createElement(ClaudeRuntimeTasksStrip, {
      sessionId: runtimeSessionId,
      api: null,
    }));
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.press(tasks.getByText('Claude Runtime Tasks'));
    const taskFrames = [
      tasks.getByTestId('runtime-tasks-header-touch'),
      tasks.getByTestId('runtime-tasks-refresh-touch'),
      tasks.getByTestId('runtime-task-output-touch-task-1'),
      tasks.getByTestId('runtime-task-stop-touch-task-1'),
    ];
    const signals = render(React.createElement(ClaudeRuntimeSignalsStrip, {
      sessionId: runtimeSessionId,
      api: null,
    }));
    const touchFrames = [
      sessionReviewFrame,
      toolHeaderFrame,
      ...taskFrames,
      signals.getByTestId('runtime-signals-header-touch'),
      signals.getByTestId('runtime-signals-refresh-touch'),
    ];
    const caption = render(React.createElement(CollapsibleCaption, {
      title: 'Jev 후보 3',
      children: '접힌 내용',
    }));
    touchFrames.push(caption.getByRole('button', { name: 'Jev 후보 3' }));

    for (const frame of touchFrames) {
      const style = StyleSheet.flatten(frame.props.style);
      const width = typeof style.minWidth === 'number'
        ? style.minWidth
        : typeof style.width === 'number' ? style.width : 0;
      const height = typeof style.minHeight === 'number'
        ? style.minHeight
        : typeof style.height === 'number' ? style.height : 0;
      expect(width).toBeGreaterThanOrEqual(minimum);
      expect(height).toBeGreaterThanOrEqual(minimum);
    }
  });
});

function hasMinimumTouchTarget(source: string): boolean {
  return hasMinimumTouchHeight(source) && hasMinimumTouchWidth(source);
}

function hasMinimumTouchHeight(source: string): boolean {
  const direct44 = /(?:minHeight|height)\s*:\s*(?:t\.)?(?:hitTarget\.min|foundation\.(?:hitTarget|iconFrame\.action|minHeight\.(?:field|secondary|primary|context|row|task|memo|composer))|controlHeight\.(?:button|input|sendBtn))\b|(?:minHeight|height)\s*:\s*(?:planner\.(?:actionColumn|minHeight\.(?:context|row|task|memo))|sessionRoles\.chat\.hitTarget)\b|(?:minHeight|height)\s*:\s*DESIGN_HIT_TARGET\.min\b|minHeight\s*:\s*Math\.max\(t\.hitTarget\.min,\s*primitive\.minHeight\)/.test(source);
  return direct44 || /(?:minHeight|height)\s*:\s*(?:4[4-9]|[5-9]\d|[1-9]\d{2,})\b/.test(source);
}

function hasMinimumTouchWidth(source: string): boolean {
  const direct44 = /(?:minWidth|width)\s*:\s*(?:t\.)?(?:hitTarget\.min|foundation\.(?:hitTarget|iconFrame\.action))\b|(?:minWidth|width)\s*:\s*(?:planner\.actionColumn|sessionRoles\.chat\.hitTarget)\b|(?:minWidth|width)\s*:\s*DESIGN_HIT_TARGET\.min\b|minWidth\s*:\s*Math\.max\(t\.hitTarget\.min,\s*primitive\.minHeight\)/.test(source);
  const roleSizedWidth = /(?:minWidth|width)\s*:\s*t\.controlHeight\.(?:button|input|sendBtn)\b/.test(source);
  const fixed44OrLarger = /(?:minWidth|width)\s*:\s*(?:[4-9]\d|[1-9]\d{2,})\b/.test(source);
  const fillsAvailableWidth = /\bflex\s*:\s*1\b|\bwidth\s*:\s*['"]100%['"]|\balignSelf\s*:\s*['"]stretch['"]/.test(source);
  // 텍스트 버튼은 수평 padding으로, 복합 행은 자식들의 합산 폭으로 가로축을 확보한다.
  // 이 두 신호가 없던 짧은 2글자 액션은 minWidth token 없이는 계약을 통과하지 못한다.
  const contentDrivenWidth = /\bpaddingHorizontal\s*:|\bflexDirection\s*:\s*['"]row['"]/.test(source);
  return direct44
    || roleSizedWidth
    || fixed44OrLarger
    || fillsAvailableWidth
    || contentDrivenWidth;
}

function collectStyles(sourceFile: ts.SourceFile, absolutePath: string): Map<string, string> {
  const result = new Map<string, string>();
  collectStyleSheetObjects(sourceFile, result);

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    const bindings = statement.importClause?.namedBindings;
    const importsStyles = bindings && ts.isNamedImports(bindings) && bindings.elements.some((element) => /Styles$/.test(element.name.text));
    if (!specifier.startsWith('.') || (!specifier.includes('.styles') && !importsStyles)) continue;
    const importedPath = resolveTypeScriptImport(path.dirname(absolutePath), specifier);
    if (!importedPath) continue;
    const importedText = fs.readFileSync(importedPath, 'utf8');
    const importedFile = ts.createSourceFile(
      importedPath,
      importedText,
      ts.ScriptTarget.Latest,
      true,
      importedPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    collectStyleSheetObjects(importedFile, result);
  }
  return result;
}

function collectStyleSheetObjects(sourceFile: ts.SourceFile, result: Map<string, string>): void {
  visit(sourceFile, (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
    if (node.expression.expression.getText(sourceFile) !== 'StyleSheet' || node.expression.name.text !== 'create') return;
    const argument = node.arguments[0];
    if (!argument || !ts.isObjectLiteralExpression(argument)) return;
    for (const property of argument.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const name = property.name.getText(sourceFile).replace(/^['"]|['"]$/g, '');
      result.set(name, property.initializer.getText(sourceFile));
    }
  });
}

function visit(node: ts.Node, callback: (node: ts.Node) => void): void {
  callback(node);
  node.forEachChild((child) => visit(child, callback));
}

function resolveTypeScriptImport(directory: string, specifier: string): string | null {
  for (const suffix of ['.ts', '.tsx', '/index.ts', '/index.tsx']) {
    const candidate = path.resolve(directory, `${specifier}${suffix}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

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

function relative(absolutePath: string): string {
  return path.relative(SRC_ROOT, absolutePath).replaceAll(path.sep, '/');
}
