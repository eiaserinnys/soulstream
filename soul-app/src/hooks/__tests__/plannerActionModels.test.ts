import type { PlannerBlock } from '../../api/plannerTypes';
import { projectDescriptionBlocks } from '../plannerActionModels';

test('설명 낙관적 투영은 paragraph·checklist만 교체하고 정본 블록을 보존한다', () => {
  const protectedBlocks = [
    block('defaults', 'session_defaults'),
    block('guidance', 'guidance', '검수 원칙'),
    block('atom', 'atom_ref'),
    block('folder', 'folder_ref'),
  ];
  const result = projectDescriptionBlocks([
    block('description', 'paragraph', '기존 설명'),
    block('checklist', 'checklist', '완료 조건'),
    ...protectedBlocks,
  ], 'task-1', '새 설명');

  expect(result.map((candidate) => candidate.id)).toEqual([
    'pending-block-task-1',
    ...protectedBlocks.map((candidate) => candidate.id),
  ]);
  expect(result[0]).toMatchObject({ blockType: 'paragraph', text: '새 설명' });
});

function block(id: string, blockType: string, text = ''): PlannerBlock {
  return {
    id,
    pageId: 'task-1',
    parentId: null,
    positionKey: '',
    blockType,
    text,
    properties: {},
    collapsed: false,
  };
}
