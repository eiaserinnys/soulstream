import React from 'react';
import { act, render, waitFor } from '@testing-library/react-native';

import {
  useNewSessionSelection,
  type NewSessionSelectionApi,
  type UseNewSessionSelectionResult,
} from '../useNewSessionSelection';
import { useAuthStore } from '../../../store/authStore';
import { resetAuthScopeForTest } from '../../../lib/auth-scope';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

describe('useNewSessionSelection', () => {
  beforeEach(() => {
    useAuthStore.getState().setJwt('account-a');
    resetAuthScopeForTest();
  });
  test('승계 창은 이전 세션의 노드·에이전트를 기본 선택으로 재사용한다', async () => {
    const api: NewSessionSelectionApi = {
      listNodes: jest.fn().mockResolvedValue({ nodes: [{ nodeId: 'node-a' }] }),
      listNodeAgents: jest.fn().mockResolvedValue({
        agents: [{ id: 'agent-a', name: 'Agent A', default_preset: 'agent-model' }],
      }),
      listModelPresets: jest.fn().mockResolvedValue({
        model_presets: [preset('agent-model', true)],
      }),
    };
    let latest!: UseNewSessionSelectionResult;

    function Probe() {
      latest = useNewSessionSelection({
        visible: true,
        api,
        folders: [],
        defaultFolderId: null,
        settingsNodeId: 'node-default',
        defaultNodeId: 'node-a',
        defaultAgentId: 'agent-a',
      });
      return null;
    }

    render(<Probe />);

    await waitFor(() => expect(api.listNodeAgents).toHaveBeenCalledWith('node-a'));
    await waitFor(() => expect(latest.agentId).toBe('agent-a'));
    expect(latest.selectedNodeId).toBe('node-a');
    expect(latest.selectedNodeName).toBe('node-a');
    expect(latest.selectedAgentName).toBe('Agent A');
    expect(latest.effectiveModelPresetId).toBe('agent-model');
    expect(latest.selectedModelPresetName).toBe('자동 (Model agent-model)');
    expect(latest.modelPresetSelectionInvalid).toBe(false);
  });

  test('resets the selected agent and reloads agents when the effective node changes', async () => {
    const api: NewSessionSelectionApi = {
      listNodes: jest.fn().mockResolvedValue({
        nodes: [{ nodeId: 'node-a' }, { nodeId: 'node-b' }],
      }),
      listNodeAgents: jest.fn(async (nodeId: string) => ({
        agents: [{ id: `agent-${nodeId}`, name: `Agent ${nodeId}` }],
      })),
      listModelPresets: jest.fn(async (nodeId: string) => ({
        model_presets: [preset(`model-${nodeId}`, true)],
      })),
    };
    let latest!: UseNewSessionSelectionResult;

    function Probe() {
      latest = useNewSessionSelection({
        visible: true,
        api,
        folders: [],
        defaultFolderId: null,
        settingsNodeId: 'node-default',
      });
      return null;
    }

    render(<Probe />);

    await waitFor(() => {
      expect(api.listNodeAgents).toHaveBeenCalledWith('node-default');
    });

    act(() => {
      latest.setAgentId('agent-node-default');
    });
    await waitFor(() => {
      expect(latest.agentId).toBe('agent-node-default');
    });

    act(() => {
      latest.setSelectedNodeId('node-a');
    });

    await waitFor(() => {
      expect(api.listNodeAgents).toHaveBeenCalledWith('node-a');
    });
    await waitFor(() => {
      expect(latest.agentId).toBeNull();
    });
    expect(latest.selectedModelPresetId).toBeNull();
    expect(api.listModelPresets).toHaveBeenCalledWith('node-a');
  });

  test('노드 변경은 이전 노드 preset을 지우고 새 노드 가용성을 다시 평가한다', async () => {
    const api: NewSessionSelectionApi = {
      listNodes: jest.fn().mockResolvedValue({
        nodes: [{ nodeId: 'node-a' }, { nodeId: 'node-b' }],
      }),
      listNodeAgents: jest.fn().mockResolvedValue({
        agents: [{ id: 'agent-a', name: 'Agent A' }],
      }),
      listModelPresets: jest.fn(async (nodeId: string) => ({
        model_presets: nodeId === 'node-a'
          ? [preset('task-model', false)]
          : [preset('node-b-model', true)],
      })),
    };
    let latest!: UseNewSessionSelectionResult;
    function Probe() {
      latest = useNewSessionSelection({
        visible: true,
        api,
        folders: [],
        defaultFolderId: null,
        settingsNodeId: null,
        defaultNodeId: 'node-a',
        defaultAgentId: 'agent-a',
        defaultModelPresetId: 'task-model',
      });
      return null;
    }
    render(<Probe />);

    await waitFor(() => expect(latest.modelPresetSelectionInvalid).toBe(true));
    expect(latest.selectedModelPresetId).toBe('task-model');

    act(() => latest.setSelectedNodeId('node-b'));

    await waitFor(() => expect(api.listModelPresets).toHaveBeenCalledWith('node-b'));
    await waitFor(() => expect(latest.modelPresets.map((item) => item.id))
      .toEqual(['node-b-model']));
    expect(latest.selectedModelPresetId).toBeNull();
    expect(latest.modelPresetSelectionInvalid).toBe(false);
  });

  test('generation 전환은 node/agent 선택을 초기화하고 old late response를 B 선택기에 넣지 않는다', async () => {
    const oldNodes = deferred<{ nodes?: Array<{ nodeId: string }> }>();
    const listNodes = jest.fn()
      .mockImplementationOnce(() => oldNodes.promise)
      .mockResolvedValueOnce({ nodes: [{ nodeId: 'node-b' }] });
    const api: NewSessionSelectionApi = {
      listNodes,
      listNodeAgents: jest.fn().mockResolvedValue({ agents: [] }),
      listModelPresets: jest.fn().mockResolvedValue({ model_presets: [] }),
    };
    let latest!: UseNewSessionSelectionResult;
    function Probe() {
      latest = useNewSessionSelection({
        visible: true,
        api,
        folders: [],
        defaultFolderId: null,
        settingsNodeId: null,
      });
      return null;
    }
    render(<Probe />);
    expect(listNodes).toHaveBeenCalledTimes(1);

    await act(async () => {
      useAuthStore.getState().setJwt('account-b');
      await Promise.resolve();
    });
    await waitFor(() => expect(listNodes).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(latest.nodes.map((node) => node.nodeId)).toEqual(['node-b']));

    await act(async () => {
      oldNodes.resolve({ nodes: [{ nodeId: 'node-a-stale' }] });
      await Promise.resolve();
    });
    expect(latest.nodes.map((node) => node.nodeId)).toEqual(['node-b']);
    expect(latest.selectedNodeId).toBeNull();
    expect(latest.agentId).toBeNull();
  });

  test('기본 담당 조회가 동기로 실패해도 새 세션 열기 effect를 중단시키지 않는다', async () => {
    const failure = new Error('native client boundary failed before returning a promise');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const onLoadError = jest.fn();
    const api: NewSessionSelectionApi = {
      listNodes: jest.fn().mockResolvedValue({ nodes: [{ nodeId: 'eiaserinnys' }] }),
      listNodeAgents: jest.fn(() => { throw failure; }),
      listModelPresets: jest.fn().mockResolvedValue({ model_presets: [] }),
    };
    let latest!: UseNewSessionSelectionResult;

    function Probe() {
      latest = useNewSessionSelection({
        visible: true,
        api,
        folders: [],
        defaultFolderId: null,
        settingsNodeId: 'eiaserinnys',
        defaultNodeId: 'eiaserinnys',
        defaultAgentId: 'seosoyoung_codex',
        onLoadError,
      });
      return null;
    }

    expect(() => render(<Probe />)).not.toThrow();
    await waitFor(() => expect(api.listNodeAgents).toHaveBeenCalledWith('eiaserinnys'));
    expect(latest.agentId).toBe('seosoyoung_codex');
    expect(warn).toHaveBeenCalledWith(
      '[NewSessionSheet] agent list fetch failed:',
      failure,
    );
    expect(onLoadError).toHaveBeenCalledWith({ phase: 'agents', error: failure });
  });

  test('preset 목록 조회 실패는 자동 기본 preset을 로딩 문구에 가두지 않는다', async () => {
    const failure = new Error('preset endpoint unavailable');
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const api: NewSessionSelectionApi = {
      listNodes: jest.fn().mockResolvedValue({ nodes: [{ nodeId: 'node-a' }] }),
      listNodeAgents: jest.fn().mockResolvedValue({
        agents: [{ id: 'agent-a', name: 'Agent A', default_preset: 'agent-model' }],
      }),
      listModelPresets: jest.fn().mockRejectedValue(failure),
    };
    let latest!: UseNewSessionSelectionResult;

    function Probe() {
      latest = useNewSessionSelection({
        visible: true,
        api,
        folders: [],
        settingsNodeId: null,
        defaultNodeId: 'node-a',
        defaultAgentId: 'agent-a',
      });
      return null;
    }

    render(<Probe />);

    await waitFor(() => expect(api.listModelPresets).toHaveBeenCalledWith('node-a'));
    await waitFor(() => expect(latest.selectedModelPresetName)
      .toBe('모델 목록을 불러오지 못했습니다'));
    expect(latest.modelPresetSelectionInvalid).toBe(false);
  });
});

function preset(id: string, available: boolean) {
  return {
    id,
    label: `Model ${id}`,
    backend: 'server-backend',
    available,
    reason: available ? null : 'server-reason',
    reason_label: available ? null : '제한',
    resets_at: null,
    usage_warning: false,
  };
}
