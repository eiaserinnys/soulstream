import type { PlannerBlock } from '../../api/plannerTypes';
import {
  folderContextOperations,
  folderSettingsDraftFromBlocks,
  formatExecutionDefaultsSummary,
  initialContextFromDraft,
  type FolderSettingsDraft,
} from '../folder-settings';

const ids = () => {
  let next = 0;
  return (prefix: string) => `${prefix}-${++next}`;
};

const blocks: PlannerBlock[] = [
  block('title', 'heading', '대시보드', {}),
  block('g1', 'guidance', '첫 지침', { enabled: true, scope: 'folder' }),
  block('body', 'paragraph', '설명', {}),
  block('g2', 'guidance', '둘째 지침', { enabled: true, scope: 'project' }),
  block('a1', 'atom_ref', '', { instance: 'atom', nodeId: 'n1', nodeTitle: '프론트엔드', depth: 2, titlesOnly: true, limit: 9, mode: 'index' }),
  block('d1', 'session_defaults', '', { scope: 'project', agentId: 'roselin', nodeId: 'eiaserinnys', modelPreset: 'sol' }),
  block('d2', 'session_defaults', '', { scope: 'session', agentId: 'old', nodeId: 'old-node' }),
];

test('지침 블록이 여럿이면 순서대로 빈 줄로 이어 글 상자 하나에 보인다', () => {
  const draft = folderSettingsDraftFromBlocks({ title: '대시보드', description: '설명', blocks });
  expect(draft.guidanceSource).toBe('own');
  expect(draft.guidance).toBe('첫 지침\n\n둘째 지침');
  expect(draft.defaultsSource).toBe('own');
  expect(draft.defaults).toEqual({ nodeId: 'eiaserinnys', agentId: 'roselin', modelPreset: 'sol' });
  expect(draft.atomReferences).toEqual([expect.objectContaining({ blockId: 'a1', limit: 9, mode: 'index' })]);
  expect(folderSettingsDraftFromBlocks({ title: '', description: '', blocks: [] })).toEqual(expect.objectContaining({
    guidanceSource: 'inherit', guidance: '', defaultsSource: 'inherit', atomReferences: [],
  }));
});

test('지침을 저장하면 그 폴더의 지침 블록이 scope project 블록 하나로 바뀐다', () => {
  const draft = { ...folderSettingsDraftFromBlocks({ title: '', description: '', blocks }), guidance: '하나로 합친 지침' };
  const operations = folderContextOperations(blocks, draft, ids());
  expect(operations.filter((operation) => 'block_id' in operation && ['g1', 'g2'].includes(operation.block_id))).toEqual([
    { op: 'update_block_text', block_id: 'g1', text: '하나로 합친 지침' },
    { op: 'update_block_type_and_properties', block_id: 'g1', block_type: 'guidance', properties: { enabled: true, scope: 'project' } },
    { op: 'delete_block_subtree', block_id: 'g2' },
  ]);
});

test('지침이 없던 폴더에 지침을 정하면 새 project 블록 하나를 만든다', () => {
  const draft = { ...folderSettingsDraftFromBlocks({ title: '', description: '', blocks: [] }), guidanceSource: 'own' as const, guidance: ' 새 지침 ' };
  expect(folderContextOperations([block('body', 'paragraph', '설명', {})], draft, ids())).toEqual([{
    op: 'create_block', temp_id: 'guidance-1', parent_id: null, after_block_id: 'body',
    block_type: 'guidance', text: '새 지침', properties: { enabled: true, scope: 'project' }, collapsed: false,
  }]);
});

test('물려받기로 저장하면 그 폴더의 지침 블록과 기본 실행 환경 블록을 모두 지운다', () => {
  const draft: FolderSettingsDraft = {
    ...folderSettingsDraftFromBlocks({ title: '', description: '', blocks }),
    guidanceSource: 'inherit',
    defaultsSource: 'inherit',
  };
  expect(folderContextOperations(blocks, draft, ids())).toEqual([
    { op: 'delete_block_subtree', block_id: 'g1' },
    { op: 'delete_block_subtree', block_id: 'g2' },
    { op: 'delete_block_subtree', block_id: 'd1' },
    { op: 'delete_block_subtree', block_id: 'd2' },
  ]);
});

test('기본 실행 환경 저장은 scope session 블록 하나로 바꾼다', () => {
  const draft: FolderSettingsDraft = {
    ...folderSettingsDraftFromBlocks({ title: '', description: '', blocks }),
    defaults: { nodeId: 'eiaserinnys', agentId: 'utonium', modelPreset: null },
  };
  const operations = folderContextOperations(blocks, draft, ids());
  expect(operations.filter((operation) => 'block_id' in operation && ['d1', 'd2'].includes(operation.block_id))).toEqual([
    { op: 'update_block_type_and_properties', block_id: 'd1', block_type: 'session_defaults',
      properties: { agentId: 'utonium', nodeId: 'eiaserinnys', scope: 'session' } },
    { op: 'delete_block_subtree', block_id: 'd2' },
  ]);
  const fresh = folderContextOperations([], {
    ...draft, guidanceSource: 'inherit', atomReferences: [],
  }, ids());
  expect(fresh).toEqual([expect.objectContaining({
    op: 'create_block', block_type: 'session_defaults',
    properties: { agentId: 'utonium', nodeId: 'eiaserinnys', scope: 'session' },
  })]);
  expect(() => folderContextOperations([], { ...draft, defaults: { nodeId: 'eiaserinnys', agentId: null, modelPreset: null } }, ids()))
    .toThrow('노드와 에이전트');
});

test('참고 자료는 붙이고 빼고 고치며, 고칠 때 limit과 mode를 그대로 싣는다', () => {
  const base = folderSettingsDraftFromBlocks({ title: '', description: '', blocks });
  const edited: FolderSettingsDraft = {
    ...base,
    atomReferences: [
      { ...base.atomReferences[0]!, depth: 4, titlesOnly: false },
      { blockId: null, instance: 'atom', nodeId: 'n2', nodeTitle: 'UI 디자인 기준', depth: 1, titlesOnly: false },
    ],
  };
  const operations = folderContextOperations(blocks, edited, ids());
  expect(operations).toContainEqual({
    op: 'update_block_type_and_properties', block_id: 'a1', block_type: 'atom_ref',
    properties: { instance: 'atom', nodeId: 'n1', nodeTitle: '프론트엔드', depth: 4, titlesOnly: false, limit: 9, mode: 'index' },
  });
  expect(operations).toContainEqual(expect.objectContaining({
    op: 'create_block', block_type: 'atom_ref',
    properties: { instance: 'atom', nodeId: 'n2', nodeTitle: 'UI 디자인 기준', depth: 1, titlesOnly: false },
  }));
  const removed = folderContextOperations(blocks, { ...base, atomReferences: [] }, ids());
  expect(removed).toContainEqual({ op: 'delete_block_subtree', block_id: 'a1' });
  expect(folderContextOperations(blocks, base, ids()).filter((operation) => operation.op !== 'update_block_type_and_properties' && operation.op !== 'update_block_text' && operation.op !== 'delete_block_subtree')).toEqual([]);
});

test('새 폴더 initialContext도 지침 한 칸과 직접 정한 기본 실행 환경만 싣는다', () => {
  const draft: FolderSettingsDraft = {
    title: '새 폴더', description: '',
    guidanceSource: 'own', guidance: ' 지침 ',
    atomReferences: [{ blockId: null, instance: 'atom', nodeId: 'n1', nodeTitle: '노드', depth: 2, titlesOnly: true }],
    defaultsSource: 'own', defaults: { nodeId: 'eiaserinnys', agentId: 'roselin', modelPreset: null },
  };
  expect(initialContextFromDraft(draft)).toEqual({
    guidance: '지침',
    atomReferences: [{ instance: 'atom', nodeId: 'n1', nodeTitle: '노드', depth: 2, titlesOnly: true }],
    sessionDefaults: { nodeId: 'eiaserinnys', agentId: 'roselin' },
  });
  expect(initialContextFromDraft({ ...draft, guidanceSource: 'inherit', defaultsSource: 'inherit' })).toEqual({
    guidance: '',
    atomReferences: [{ instance: 'atom', nodeId: 'n1', nodeTitle: '노드', depth: 2, titlesOnly: true }],
  });
});

test('기본 실행 환경 요약 줄은 표시 이름을 에이전트, 노드, 모델 순서로 잇는다', () => {
  expect(formatExecutionDefaultsSummary({ agentName: '로젤린', nodeName: 'eiaserinnys', modelName: 'Sol' }))
    .toBe('로젤린 · eiaserinnys · Sol');
  expect(formatExecutionDefaultsSummary({ agentName: '로젤린', nodeName: 'eiaserinnys', modelName: null }))
    .toBe('로젤린 · eiaserinnys');
});

function block(id: string, blockType: string, text: string, properties: Record<string, unknown>): PlannerBlock {
  return { id, pageId: 'page', parentId: null, positionKey: id, blockType, text, properties, collapsed: false };
}
