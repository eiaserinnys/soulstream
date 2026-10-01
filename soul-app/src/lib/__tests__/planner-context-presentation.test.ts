import type { PlannerBlock } from '../../api/plannerTypes';
import { buildPlannerContextPresentation } from '../planner-context-presentation';

const block = (
  id: string,
  blockType: string,
  text: string,
  properties: Record<string, unknown> = {},
): PlannerBlock => ({
  id, pageId: 'page', parentId: null, positionKey: id,
  blockType, text, properties, collapsed: false,
});

test('프로젝트 상속 컨텍스트와 업무 직접 컨텍스트의 출처를 구분한다', () => {
  const result = buildPlannerContextPresentation({
    projectName: '소울스트림',
    projectBlocks: [
      block('project-guidance', 'guidance', '프로젝트 원칙', { enabled: true }),
      block('project-atom', 'atom_ref', '', {
        instance: 'atom', nodeId: 'service-operations', nodeTitle: '서비스 운영',
      }),
      block('project-defaults', 'session_defaults', '', {
        agentId: 'seosoyoung', nodeId: 'eiaserinnys', modelPreset: 'project-model',
      }),
    ],
    folderBlocks: [
      block('task-guidance', 'guidance', '업무 원칙', { enabled: true }),
      block('task-defaults', 'session_defaults', '', {
        agentId: 'roselin_codex', nodeId: 'eiaserinnys', modelPreset: 'task-model',
      }),
    ],
  });

  expect(result.contexts).toEqual([
    { id: 'project-guidance', icon: '✦', label: '프로젝트 원칙', kind: 'guidance', sourceLabel: '소울스트림에서 상속' },
    { id: 'project-atom', icon: '⚛', label: '서비스 운영', kind: 'atom', sourceLabel: '소울스트림에서 상속' },
    { id: 'task-guidance', icon: '✦', label: '업무 원칙', kind: 'guidance', sourceLabel: '이 폴더' },
  ]);
  expect(result.assignment).toEqual({
    agentId: 'roselin_codex',
    nodeId: 'eiaserinnys',
    modelPreset: 'task-model',
    blockId: 'task-defaults',
    sourceLabel: '직접 지정',
  });
});

test('직접 지정이 없으면 프로젝트 기본 담당을 상속 표시한다', () => {
  const result = buildPlannerContextPresentation({
    projectName: '소울스트림',
    projectBlocks: [
      block('project-defaults', 'session_defaults', '', { agentId: 'seosoyoung', nodeId: 'eiaserinnys' }),
    ],
    folderBlocks: [],
  });

  expect(result.assignment?.sourceLabel).toBe('소울스트림에서 상속');
});

test('업무 기본 담당에 모델이 없으면 프로젝트 모델 preset을 다음 사다리로 사용한다', () => {
  const result = buildPlannerContextPresentation({
    projectName: '소울스트림',
    projectBlocks: [
      block('project-defaults', 'session_defaults', '', {
        agentId: 'project-agent',
        nodeId: 'project-node',
        modelPreset: 'project-model',
      }),
    ],
    folderBlocks: [
      block('task-defaults', 'session_defaults', '', {
        agentId: 'task-agent',
        nodeId: 'task-node',
      }),
    ],
  });

  expect(result.assignment).toMatchObject({
    agentId: 'task-agent',
    nodeId: 'task-node',
    modelPreset: 'project-model',
  });
});

test('화이트리스트 밖 블록은 컨텍스트로 투영하지 않고 직접 문서 마운트만 유지한다', () => {
  const result = buildPlannerContextPresentation({
    projectName: '소울스트림',
    projectBlocks: [
      block('project-document', 'paragraph', '[[상속되면 안 되는 문서]]'),
      block('project-session', 'session_ref', '', { primary: true, sessionId: 'session-project' }),
    ],
    folderBlocks: [
      block('enabled-guidance', 'guidance', '  실행 원칙  ', { enabled: true }),
      block('disabled-guidance', 'guidance', '비활성 지침', { enabled: false }),
      block('implicit-guidance', 'guidance', 'enabled 없는 지침'),
      block('blank-guidance', 'guidance', '   ', { enabled: true }),
      block('document', 'paragraph', '[[설계 문서]]'),
      block('plain-paragraph', 'paragraph', '일반 본문'),
      block('session', 'session_ref', '', { primary: true, sessionId: 'session-task' }),
      block('task', 'task_ref', '', { folderId: 'task-1' }),
      block('runbook', 'runbook_ref', '업무 참조'),
      block('future', 'future_context_source', '미래 블록'),
    ],
  });

  expect(result.contexts).toEqual([
    {
      id: 'enabled-guidance', icon: '✦', label: '실행 원칙',
      kind: 'guidance', sourceLabel: '이 폴더',
    },
    {
      id: 'document', icon: '📄', label: '설계 문서',
      kind: 'document', sourceLabel: '이 폴더',
    },
  ]);
});

test('atom 참조는 지원 인스턴스와 nodeId가 있을 때 웹과 같은 라벨 순서로 투영한다', () => {
  const result = buildPlannerContextPresentation({
    projectName: '소울스트림',
    projectBlocks: [
      block('node-title', 'atom_ref', '', { nodeId: 'node-1', nodeTitle: '노드 제목' }),
      block('title', 'atom_ref', '', { instance: 'atom-nl', nodeId: 'node-2', title: '일반 제목' }),
      block('label', 'atom_ref', '', { instance: 'atom', nodeId: 'node-3', label: '라벨 제목' }),
      block('node-id', 'atom_ref', '', { instance: 'atom', nodeId: 'node-4' }),
      block('unsupported', 'atom_ref', '', { instance: 'other', nodeId: 'node-5', nodeTitle: '제외' }),
      block('missing-node', 'atom_ref', '', { instance: 'atom', nodeTitle: '제외' }),
    ],
    folderBlocks: [],
  });

  expect(result.contexts.map(({ id, label }) => ({ id, label }))).toEqual([
    { id: 'node-title', label: '노드 제목' },
    { id: 'title', label: '일반 제목' },
    { id: 'label', label: '라벨 제목' },
    { id: 'node-id', label: 'node-4' },
  ]);
});
