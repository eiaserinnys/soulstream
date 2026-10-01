import {
  emptyInitialFolderContext,
  serializeInitialFolderContext,
} from '../initialFolderContext';

test('빈 초기 컨텍스트는 wire에서 생략한다', () => {
  expect(serializeInitialFolderContext(emptyInitialFolderContext())).toBeUndefined();
});

test('guidance·atom 옵션·기본 담당을 서버 snake_case 계약으로 직렬화한다', () => {
  expect(serializeInitialFolderContext({
    guidance: '  업무 지침  ',
    atomReferences: [{
      instance: 'atom',
      nodeId: ' node-1 ',
      nodeTitle: ' 규칙 ',
      depth: 5,
      titlesOnly: true,
    }],
    sessionDefaults: {
      agentId: ' roselin_codex ',
      nodeId: ' eiaserinnys ',
      modelPreset: ' server-preset ',
    },
  })).toEqual({
    guidance: '업무 지침',
    atom_references: [{
      instance: 'atom',
      node_id: 'node-1',
      node_title: '규칙',
      depth: 5,
      titles_only: true,
    }],
    session_defaults: {
      agent_id: 'roselin_codex',
      node_id: 'eiaserinnys',
      model_preset: 'server-preset',
    },
  });
});

test('기본 담당은 agent와 node가 모두 있을 때만 전송한다', () => {
  expect(() => serializeInitialFolderContext({
    guidance: '',
    atomReferences: [],
    sessionDefaults: { agentId: 'roselin_codex', nodeId: ' ' },
  })).toThrow('기본 담당은 에이전트와 노드를 모두 선택해야 합니다.');
});
