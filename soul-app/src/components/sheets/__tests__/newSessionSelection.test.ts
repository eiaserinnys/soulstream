import {
  buildAgentActionSheet,
  buildFolderActionSheet,
  buildModelPresetActionSheet,
  buildNodeActionSheet,
  formatModelPresetLabel,
  resolveAgentActionSheetSelection,
  resolveFolderActionSheetSelection,
  resolveModelPresetActionSheetSelection,
  resolveNodeActionSheetSelection,
  resolveSelectedAgentName,
  resolveSelectedFolderName,
  resolveSelectedModelPresetName,
  resolveSelectedNodeName,
  sortNewSessionFolders,
} from '../newSessionSelection';

describe('newSessionSelection', () => {
  test('maps node ActionSheet options and selected labels without undefined entries', () => {
    const nodes = [{ nodeId: 'node-a' }, { nodeId: 'node-b' }];
    const sheet = buildNodeActionSheet(nodes);

    expect(sheet).toEqual({
      options: ['자동', 'node-a', 'node-b', '취소'],
      cancelButtonIndex: 3,
      title: '노드 선택',
    });
    expect(resolveNodeActionSheetSelection(0, nodes, sheet.cancelButtonIndex)).toEqual({
      cancelled: false,
      nodeId: null,
    });
    expect(resolveNodeActionSheetSelection(2, nodes, sheet.cancelButtonIndex)).toEqual({
      cancelled: false,
      nodeId: 'node-b',
    });
    expect(resolveNodeActionSheetSelection(3, nodes, sheet.cancelButtonIndex)).toEqual({
      cancelled: true,
    });
    expect(resolveSelectedNodeName(null, 'node-default')).toBe('자동 (node-default)');
    expect(resolveSelectedNodeName(null, null)).toBe('자동');
    expect(resolveSelectedNodeName('node-b', 'node-default')).toBe('node-b');
  });

  test('sorts folders and maps folder ActionSheet selections', () => {
    const sortedFolders = sortNewSessionFolders([
      { id: 'b', name: 'Beta', sortOrder: 20 },
      { id: 'a', name: 'Alpha', sortOrder: 10 },
      { id: 'a-child', name: 'Beta', sortOrder: 10, parentFolderId: 'a' },
    ]);
    const sheet = buildFolderActionSheet(sortedFolders);

    expect(sortedFolders.map((folder) => folder.id)).toEqual(['a', 'a-child', 'b']);
    expect(sheet).toEqual({
      options: ['폴더 선택 안 함', 'Alpha', '› Beta', 'Beta', '취소'],
      cancelButtonIndex: 4,
      title: '폴더 선택',
    });
    expect(resolveFolderActionSheetSelection(0, sortedFolders, sheet.cancelButtonIndex)).toEqual({
      cancelled: false,
      folderId: null,
    });
    expect(resolveFolderActionSheetSelection(2, sortedFolders, sheet.cancelButtonIndex)).toEqual({
      cancelled: false,
      folderId: 'a-child',
    });
    expect(resolveSelectedFolderName(null, sortedFolders)).toBe('폴더 선택 안 함');
    expect(resolveSelectedFolderName('a-child', sortedFolders)).toBe('› Beta');
    expect(resolveSelectedFolderName('missing', sortedFolders)).toBe('(알 수 없음)');
  });

  test('maps agent ActionSheet options and selected labels', () => {
    const agents = [
      { id: 'seosoyoung', name: '서소영' },
      { id: 'roselin', name: '로젤린' },
    ];
    const sheet = buildAgentActionSheet(agents);

    expect(sheet).toEqual({
      options: ['자동 선택', '서소영', '로젤린', '취소'],
      cancelButtonIndex: 3,
      title: '에이전트 선택',
    });
    expect(resolveAgentActionSheetSelection(0, agents, sheet.cancelButtonIndex)).toEqual({
      agentId: null,
      cancelled: false,
    });
    expect(resolveAgentActionSheetSelection(2, agents, sheet.cancelButtonIndex)).toEqual({
      agentId: 'roselin',
      cancelled: false,
    });
    expect(resolveAgentActionSheetSelection(3, agents, sheet.cancelButtonIndex)).toEqual({
      cancelled: true,
    });
    expect(resolveSelectedAgentName(null, agents)).toBe('자동 선택');
    expect(resolveSelectedAgentName('missing', agents)).toBe('(알 수 없음)');
  });

  test('native ActionSheet options never contain nullish values from server payloads', () => {
    const nodes = [
      { nodeId: 'node-a' },
      { nodeId: null },
      { nodeId: undefined },
    ] as any;
    const agents = [
      { id: 'named', name: '서소영' },
      { id: 'null-name', name: null },
      { id: 'missing-name', name: undefined },
    ] as any;

    expect(buildNodeActionSheet(nodes).options).toEqual([
      '자동',
      'node-a',
      '(알 수 없는 노드)',
      '(알 수 없는 노드)',
      '취소',
    ]);
    expect(buildAgentActionSheet(agents).options).toEqual([
      '자동 선택',
      '서소영',
      '(이름 없는 에이전트)',
      '(이름 없는 에이전트)',
      '취소',
    ]);
    expect(buildNodeActionSheet(nodes).options.every((option) => typeof option === 'string'))
      .toBe(true);
    expect(buildAgentActionSheet(agents).options.every((option) => typeof option === 'string'))
      .toBe(true);
    expect(resolveSelectedAgentName('null-name', agents)).toBe('(이름 없는 에이전트)');
  });

  test('모델 preset은 서버 라벨만 표시하고 불가 항목만 비활성화한다', () => {
    const presets = [
      {
        id: 'available',
        label: '서버 모델 A',
        backend: 'server-backend-a',
        available: true,
        reason: null,
        reason_label: null,
        resets_at: null,
        usage_warning: false,
      },
      {
        id: 'limited',
        label: '서버 모델 B',
        backend: 'server-backend-b',
        available: false,
        reason: 'server-reason',
        reason_label: '서버 제한 사유',
        resets_at: '2030-01-02T03:04:00.000Z',
        usage_warning: false,
      },
      {
        id: 'warning',
        label: '서버 모델 C',
        backend: 'server-backend-c',
        available: true,
        reason: null,
        reason_label: null,
        resets_at: null,
        usage_warning: true,
      },
    ];
    const sheet = buildModelPresetActionSheet(presets);

    expect(sheet.options[0]).toBe('자동 선택');
    expect(sheet.options[1]).toBe('서버 모델 A');
    expect(sheet.options[2]).toMatch(/^서버 모델 B \(서버 제한 사유\) · \d{2}:\d{2} 해제$/);
    expect(sheet.options[3]).toBe('서버 모델 C (사용량 확인 지연)');
    expect(sheet.disabledButtonIndices).toEqual([2]);
    expect(resolveModelPresetActionSheetSelection(1, presets, sheet.cancelButtonIndex))
      .toEqual({ cancelled: false, modelPresetId: 'available' });
    expect(resolveModelPresetActionSheetSelection(2, presets, sheet.cancelButtonIndex))
      .toEqual({ cancelled: true });
    expect(resolveModelPresetActionSheetSelection(0, presets, sheet.cancelButtonIndex))
      .toEqual({ cancelled: false, modelPresetId: null });
  });

  test('선택 preset이 노드에 없으면 대체하지 않고 다시 선택하도록 표시한다', () => {
    expect(resolveSelectedModelPresetName('missing', [], false, false))
      .toBe('불러오는 중…');
    expect(resolveSelectedModelPresetName('missing', [], true, false))
      .toBe('모델을 다시 선택해 주세요');
    expect(resolveSelectedModelPresetName('missing', [], false, true))
      .toBe('모델 목록을 불러오지 못했습니다');
    expect(formatModelPresetLabel({
      id: 'unavailable',
      label: '서버 모델',
      backend: 'server-backend',
      available: false,
      reason: 'server-reason',
      reason_label: '서버 사유',
      resets_at: null,
      usage_warning: false,
    })).toBe('서버 모델 (서버 사유)');
  });
});
