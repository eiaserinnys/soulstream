jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { useSettingsStore } from '../../../store/settingsStore';
import { useSessionStore } from '../../../store/sessionStore';
import { CardAssignmentSheet } from '../CardAssignmentSheet';

test.each([null, 'sol'])('노드 미지정 폴더의 기본 담당과 소진 모델 %s를 현재 노드에 유지하고 확인한다', async modelPreset => {
  useSettingsStore.setState({ nodeId: 'node-1' });
  useSessionStore.setState({ catalog: { folders: [{ id: 'folder-1', name: '폴더', archived: false }], sessions: {} } as any });
  const api = { listNodes: jest.fn().mockResolvedValue({ nodes: [{ nodeId: 'node-1' }] }),
    listNodeAgents: jest.fn().mockResolvedValue({ agents: [{ id: 'roselin', name: '로젤린' }] }),
    listModelPresets: jest.fn().mockResolvedValue({ model_presets: [{ id: 'sol', label: 'Sol', available: true, reason: 'quota_exhausted' }] }),
    getPlannerFolder: jest.fn().mockResolvedValue({ folder: { parentFolderId: null }, blocks: [
      { id: 'defaults', blockType: 'session_defaults', properties: { agentId: 'roselin', modelPreset } },
    ] }),
  };
  const onSave = jest.fn().mockResolvedValue(undefined);
  const screen = render(<CardAssignmentSheet api={api as any} value={{ folderId: 'folder-1', nodeId: null, agentId: null, modelPreset: null }} onClose={jest.fn()} onSave={onSave} />);
  await waitFor(() => expect(screen.getByText('로젤린')).toBeTruthy());
  fireEvent.press(screen.getByText('확인'));
  await waitFor(() => expect(onSave).toHaveBeenCalledWith({ folderId: 'folder-1', nodeId: 'node-1', agentId: 'roselin', modelPreset }));
});


test('폴더 칩의 선택 시트는 폴더만 보이고 기본 담당을 적용한다', async () => {
  useSettingsStore.setState({ nodeId: 'node-1' });
  useSessionStore.setState({ catalog: { folders: [{ id: 'folder-1', name: '폴더', archived: false }], sessions: {} } as any });
  const api = { listNodes: jest.fn().mockResolvedValue({ nodes: [{ nodeId: 'node-1' }] }),
    listNodeAgents: jest.fn().mockResolvedValue({ agents: [{ id: 'roselin', name: '로젤린' }] }),
    listModelPresets: jest.fn().mockResolvedValue({ model_presets: [] }),
    getPlannerFolder: jest.fn().mockResolvedValue({ folder: { parentFolderId: null }, blocks: [
      { id: 'defaults', blockType: 'session_defaults', properties: { agentId: 'roselin' } },
    ] }),
  };
  const onSave = jest.fn().mockResolvedValue(undefined);
  const screen = render(<CardAssignmentSheet folderOnly api={api as any} value={{ folderId: 'folder-1', nodeId: null, agentId: null, modelPreset: null }} onClose={jest.fn()} onSave={onSave} />);
  await waitFor(() => expect(screen.getByRole('button', { name: '확인' }).props.accessibilityState.disabled).toBe(false));
  expect(screen.queryByText('노드')).toBeNull();
  expect(screen.queryByText('에이전트')).toBeNull();
  await waitFor(() => expect(api.getPlannerFolder).toHaveBeenCalled());
  fireEvent.press(screen.getByText('확인'));
  await waitFor(() => expect(onSave).toHaveBeenCalledWith({ folderId: 'folder-1', nodeId: 'node-1', agentId: 'roselin', modelPreset: null }));
});

test.each(['node-1', null])('상세 폴더 이동은 공통 선택기를 쓰고 지정 노드 %s를 보존한다', async (nodeId) => {
  useSettingsStore.setState({ nodeId: 'node-1' });
  useSessionStore.setState({ catalog: { folders: [{ id: 'folder-1', name: '첫 폴더' }, { id: 'folder-2', name: '둘째 폴더' }], sessions: {} } as any });
  const api = { listNodes: jest.fn().mockResolvedValue({ nodes: [{ nodeId: 'node-1' }] }), listNodeAgents: jest.fn().mockResolvedValue({ agents: [{ id: 'roselin', name: '로젤린' }] }), listModelPresets: jest.fn().mockResolvedValue({ model_presets: [] }), getStarredFolders: jest.fn().mockResolvedValue({ items: [], nextCursor: null }) };
  const onSave = jest.fn().mockResolvedValue(undefined);
  const screen = render(<CardAssignmentSheet api={api as any} mode="edit" value={{ folderId: 'folder-1', nodeId, agentId: 'roselin', modelPreset: null }} onClose={jest.fn()} onSave={onSave} />);
  await waitFor(() => expect(screen.getByText('로젤린')).toBeTruthy());
  await act(async () => fireEvent.press(screen.getByText('폴더')));
  expect(screen.getByText('별표')).toBeTruthy();
  fireEvent.press(screen.getByText('전체'));
  fireEvent.changeText(screen.getByLabelText('폴더 검색'), '둘째');
  fireEvent.press(screen.getByText('둘째 폴더'));
  fireEvent.press(screen.getByText('확인'));
  await waitFor(() => expect(onSave).toHaveBeenCalledWith({ folderId: 'folder-2', nodeId, agentId: 'roselin', modelPreset: null }));
});

test('실행 보완은 기본 노드와 기본 모델을 명시적으로 저장한다',async()=>{
 useSettingsStore.setState({nodeId:'node-1'});
 useSessionStore.setState({catalog:{folders:[{id:'folder-1',name:'폴더'}],sessions:{}} as any});
 const api={listNodes:jest.fn().mockResolvedValue({nodes:[{nodeId:'node-1'}]}),
  listNodeAgents:jest.fn().mockResolvedValue({agents:[{id:'roselin',name:'로젤린',default_preset:'sol'}]}),
  listModelPresets:jest.fn().mockResolvedValue({model_presets:[{id:'sol',label:'Sol',available:true,reason:'quota_exhausted'}]})};
 const save=jest.fn().mockResolvedValue(undefined);
 const screen=render(<CardAssignmentSheet api={api as any} mode="edit" startAfterSave value={{folderId:'folder-1',nodeId:null,agentId:'roselin',modelPreset:null}} onClose={jest.fn()} onSave={save}/>);
 await waitFor(()=>expect(screen.getByRole('button',{name:'확인'}).props.accessibilityState.disabled).toBe(false));
 await act(async()=>fireEvent.press(screen.getByText('확인')));
 expect(save).toHaveBeenCalledWith({folderId:'folder-1',nodeId:'node-1',agentId:'roselin',modelPreset:'sol'});
});
