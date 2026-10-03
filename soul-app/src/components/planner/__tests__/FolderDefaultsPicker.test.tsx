import React from 'react';
import { ActionSheetIOS } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { FolderDefaultsPicker } from '../FolderDefaultsPicker';
import { useSettingsStore } from '../../../store/settingsStore';

const api = {
  listNodes: jest.fn().mockResolvedValue({ nodes: [{ nodeId: 'node-a' }, { nodeId: 'node-b' }] }),
  listNodeAgents: jest.fn().mockResolvedValue({ agents: [{ id: 'agent-a', default_preset: 'model-a' }] }),
  listModelPresets: jest.fn().mockResolvedValue({ model_presets: [{ id: 'model-a', label: 'A', available: true }] }),
};
afterEach(() => jest.restoreAllMocks());
test('기본 노드를 자동 생성하지 않으며 변경은 확인 전 부모에 쓰지 않는다', async () => {
  useSettingsStore.setState({ nodeId: 'node-a' });
  const save = jest.fn(); const close = jest.fn();
  const screen = render(<FolderDefaultsPicker api={api as any} onSave={save} onClose={close} />);
  await act(async () => {});
  expect(screen.getByLabelText('기본 환경 확인')).toBeEnabled();
  expect(save).not.toHaveBeenCalled();
  fireEvent.press(screen.getByLabelText('기본 환경 확인'));
  expect(save).toHaveBeenCalledWith(undefined);
  expect(close).toHaveBeenCalledTimes(1);
});
test('임시 노드 선택은 취소되고 확인은 지원되는 노드와 에이전트 쌍만 반영한다', async () => {
  const save = jest.fn(); const close = jest.fn();
  jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((_options, callback) => callback(1));
  const screen = render(<FolderDefaultsPicker api={api as any} onSave={save} onClose={close} />);
  await act(async () => {});
  fireEvent.press(screen.getByTestId('new-task-default-node'));
  await waitFor(() => expect(api.listNodeAgents).toHaveBeenCalled());
  expect(screen.getByLabelText('기본 환경 확인')).toBeDisabled();
  fireEvent.press(screen.getByTestId('new-task-default-agent'));
  expect(save).not.toHaveBeenCalled();
  fireEvent.press(screen.getByLabelText('기본 환경 취소'));
  expect(save).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledTimes(1);
});
test('기존 환경의 확인 연타는 한 번만 저장하고 모델 미지정 의미를 보존한다', async () => {
  const save = jest.fn(); const close = jest.fn();
  const value = { nodeId: 'node-a', agentId: 'agent-a' };
  const screen = render(<FolderDefaultsPicker api={api as any} value={value} onSave={save} onClose={close} />);
  await waitFor(() => expect(screen.getByLabelText('기본 환경 확인')).toBeEnabled());
  const button = screen.getByLabelText('기본 환경 확인');
  act(() => { fireEvent.press(button); fireEvent.press(button); });
  expect(save).toHaveBeenCalledTimes(1); expect(save).toHaveBeenCalledWith(value); expect(close).toHaveBeenCalledTimes(1);
});
test('소진 모델을 선택한 폴더 기본값도 그대로 저장한다', async () => {
  const save = jest.fn();
  const exhaustedApi = { ...api, listModelPresets: jest.fn().mockResolvedValue({
    model_presets: [{ id: 'model-a', label: 'A', available: true, reason: 'quota_exhausted' }],
  }) };
  jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((_options, callback) => callback(1));
  const screen = render(<FolderDefaultsPicker api={exhaustedApi as any}
    value={{ nodeId: 'node-a', agentId: 'agent-a' }} onSave={save} onClose={jest.fn()} />);
  await waitFor(() => expect(exhaustedApi.listModelPresets).toHaveBeenCalled());
  act(() => fireEvent.press(screen.getByTestId('new-task-default-model')));
  expect(ActionSheetIOS.showActionSheetWithOptions).toHaveBeenCalledWith(
    expect.objectContaining({ destructiveButtonIndex: [1], disabledButtonIndices: [] }), expect.any(Function));
  expect(screen.getByLabelText('기본 환경 확인')).toBeEnabled();
  fireEvent.press(screen.getByLabelText('기본 환경 확인'));
  expect(save).toHaveBeenCalledWith({ nodeId: 'node-a', agentId: 'agent-a', modelPreset: 'model-a' });
});
