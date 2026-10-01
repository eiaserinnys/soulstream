import {
  buildNewSessionCreatePayload,
  commitNewSessionCreation,
} from '../newSessionSubmit';

describe('newSessionSubmit', () => {
  describe('buildNewSessionCreatePayload', () => {
    it('첨부가 있으면 선택 노드가 없을 때 settings node로 실행 노드를 맞춘다', () => {
      const result = buildNewSessionCreatePayload({
        text: '첨부 처리',
        selectedFolderId: null,
        agentId: null,
        selectedNodeId: null,
        settingsNodeId: 'settings-node',
        attachments: [
          { path: '/tmp/a.png', name: 'a.png' },
          { path: '/tmp/b.pdf', name: 'b.pdf' },
        ],
      });

      expect(result).toEqual({
        payload: {
          prompt:
            '첨부 처리\n\n' +
            '[첨부 파일 로컬 경로: /tmp/a.png]\n' +
            '[첨부 파일 로컬 경로: /tmp/b.pdf]',
          folderId: undefined,
          agentId: undefined,
          nodeId: 'settings-node',
          attachmentPaths: ['/tmp/a.png', '/tmp/b.pdf'],
        },
        submitNodeId: 'settings-node',
        attachmentPaths: ['/tmp/a.png', '/tmp/b.pdf'],
      });
    });

    it('선택 노드가 있으면 첨부가 있어도 선택 노드를 우선한다', () => {
      const result = buildNewSessionCreatePayload({
        text: '선택 노드',
        selectedFolderId: 'folder-1',
        agentId: 'agent-1',
        selectedNodeId: 'selected-node',
        settingsNodeId: 'settings-node',
        attachments: [{ path: '/tmp/a.png', name: 'a.png' }],
      });

      expect(result.payload).toEqual({
        prompt: '선택 노드\n\n[첨부 파일 로컬 경로: /tmp/a.png]',
        folderId: 'folder-1',
        agentId: 'agent-1',
        nodeId: 'selected-node',
        attachmentPaths: ['/tmp/a.png'],
      });
      expect(result.submitNodeId).toBe('selected-node');
    });

    it('첨부가 없고 선택 노드도 없으면 서버 자동 라우팅을 유지한다', () => {
      const result = buildNewSessionCreatePayload({
        text: '자동 라우팅',
        selectedFolderId: 'folder-1',
        agentId: null,
        selectedNodeId: null,
        settingsNodeId: 'settings-node',
        attachments: [],
      });

      expect(result).toEqual({
        payload: {
          prompt: '자동 라우팅',
          folderId: 'folder-1',
          agentId: undefined,
          nodeId: undefined,
          attachmentPaths: undefined,
        },
        submitNodeId: undefined,
        attachmentPaths: [],
      });
    });
  });

  describe('commitNewSessionCreation', () => {
    function createDeps() {
      return {
        upsertSession: jest.fn(),
        assignSessionToCatalog: jest.fn(),
        setPendingFirstMessage: jest.fn(),
        onCreated: jest.fn(),
        clearAttachments: jest.fn(),
        onClose: jest.fn(),
      };
    }

    it('생성 응답을 optimistic session, catalog, pending first message로 반영한다', () => {
      const deps = createDeps();

      const sid = commitNewSessionCreation({
        response: { agentSessionId: 'sess-1', nodeId: 'server-node' },
        text: '첫 메시지',
        selectedFolderId: 'folder-1',
        submitNodeId: 'submit-node',
        agentId: 'agent-1',
        agents: [
          { id: 'agent-1', name: '로젤린', portraitUrl: '/portrait.png' },
        ],
        now: '2026-05-24T05:00:00.000Z',
        ...deps,
      });

      expect(sid).toBe('sess-1');
      expect(deps.upsertSession).toHaveBeenCalledWith(
        expect.objectContaining({
          agentSessionId: 'sess-1',
          status: 'running',
          folderId: 'folder-1',
          nodeId: 'server-node',
          prompt: '첫 메시지',
          agentId: 'agent-1',
          agentName: '로젤린',
          agentPortraitUrl: '/portrait.png',
          lastMessage: {
            type: 'user_message',
            preview: '첫 메시지',
            timestamp: '2026-05-24T05:00:00.000Z',
          },
        }),
      );
      expect(deps.assignSessionToCatalog).toHaveBeenCalledWith(
        'sess-1',
        'folder-1',
        null,
      );
      expect(deps.setPendingFirstMessage).toHaveBeenCalledWith(
        'sess-1',
        '첫 메시지',
      );
      expect(deps.onCreated).toHaveBeenCalledWith('sess-1');
      expect(deps.clearAttachments).toHaveBeenCalledTimes(1);
      expect(deps.onClose).toHaveBeenCalledTimes(1);
    });

    it('서버 nodeId가 없으면 submit node를 optimistic session에 사용한다', () => {
      const deps = createDeps();

      commitNewSessionCreation({
        response: { agentSessionId: 'sess-2' },
        text: '첨부 메시지',
        selectedFolderId: null,
        submitNodeId: 'submit-node',
        agentId: null,
        agents: [{ id: 'solo', name: 'Solo' }],
        now: '2026-05-24T05:00:00.000Z',
        ...deps,
      });

      expect(deps.upsertSession).toHaveBeenCalledWith(
        expect.objectContaining({
          agentSessionId: 'sess-2',
          folderId: null,
          nodeId: 'submit-node',
          agentId: 'solo',
          agentName: 'Solo',
        }),
      );
      expect(deps.assignSessionToCatalog).toHaveBeenCalledWith(
        'sess-2',
        null,
        null,
      );
    });

    it('세션 ID가 없으면 후속 side effect를 실행하지 않고 실패한다', () => {
      const deps = createDeps();

      expect(() =>
        commitNewSessionCreation({
          response: {},
          text: '실패',
          selectedFolderId: 'folder-1',
          submitNodeId: undefined,
          agentId: null,
          agents: [],
          ...deps,
        }),
      ).toThrow('서버 응답에 세션 ID가 없습니다.');

      expect(deps.upsertSession).not.toHaveBeenCalled();
      expect(deps.assignSessionToCatalog).not.toHaveBeenCalled();
      expect(deps.setPendingFirstMessage).not.toHaveBeenCalled();
      expect(deps.onCreated).not.toHaveBeenCalled();
      expect(deps.clearAttachments).not.toHaveBeenCalled();
      expect(deps.onClose).not.toHaveBeenCalled();
    });
  });
});
