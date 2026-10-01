import type { PlannerBlock } from '../../api/plannerTypes';
import {
  plannerContextChips,
  plannerContextCount,
} from '../planner-context-chips';

const block = (
  id: string,
  blockType: string,
  text: string,
  properties: Record<string, unknown> = {},
): PlannerBlock => ({
  id,
  pageId: 'task-1',
  parentId: null,
  positionKey: id,
  blockType,
  text,
  properties,
  collapsed: false,
});

test('웹 v3와 같이 paragraph·folder_ref 외 블록을 컨텍스트 수로 센다', () => {
  expect(plannerContextCount([
    block('body', 'paragraph', '설명'),
    block('folder', 'folder_ref', '', { folderId: 'folder-1' }),
    block('guidance', 'guidance', '검수 원칙'),
    block('atom', 'atom_ref', '', { nodeId: 'node-a', nodeTitle: '전투 설계' }),
    block('defaults', 'session_defaults', '', { agentId: 'roselin', nodeId: 'eiaserinnys' }),
  ])).toBe(3);
});

test('사용자가 이해할 수 있는 직접 컨텍스트만 중복 없이 짧은 칩으로 투영한다', () => {
  expect(plannerContextChips([
    block('guidance', 'guidance', '검수 원칙', { enabled: true }),
    block('guidance-duplicate', 'guidance', '  검수 원칙  ', { enabled: true }),
    block('atom', 'atom_ref', '', { nodeId: 'node-a', nodeTitle: '전투 설계' }),
    block('atom-duplicate', 'atom_ref', '', { nodeId: 'node-a', nodeTitle: '전투 설계' }),
    block('defaults', 'session_defaults', '', { agentId: 'roselin', nodeId: 'eiaserinnys' }),
    block('document', 'paragraph', '[[밸런스 문서]]'),
    block('runbook', 'runbook_ref', '', { runbookId: 'runbook-1' }),
    block('session', 'session_ref', '', { sessionId: 'session-1' }),
    block('unknown', 'future_context_source', '내부 정본'),
  ])).toEqual([
    { id: 'guidance', icon: '✦', label: '검수 원칙' },
    { id: 'atom', icon: '⚛', label: '전투 설계' },
  ]);
});
