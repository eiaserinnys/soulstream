import { buildAtomContextItem } from '../planner-session-context';

test('새 세션에 더한 참고 자료는 웹과 같은 atom_context_sources 항목 하나로 실린다', () => {
  expect(buildAtomContextItem([
    { nodeId: ' n1 ', depth: 1, titlesOnly: false },
    { nodeId: 'n2', depth: 3, titlesOnly: true, mode: 'index' },
  ])).toEqual({
    key: 'atom_context_sources',
    label: '선택한 atom 노드',
    content: { nodes: [
      { node_id: 'n1', depth: 1, titles_only: false },
      { node_id: 'n2', depth: 3, titles_only: true, mode: 'index' },
    ] },
  });
  expect(buildAtomContextItem([])).toBeNull();
});
