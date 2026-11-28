import { ActionSheetIOS } from 'react-native';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
import { FolderDefaultsFields } from '../FolderDefaultsFields';
import { useSettingsStore } from '../../../store/settingsStore';

const api = {
  listNodes: jest.fn().mockResolvedValue({ nodes: [{ nodeId: 'node-a' }, { nodeId: 'node-b' }] }),
  listNodeAgents: jest.fn().mockResolvedValue({ agents: [{ id: 'agent-a', name: '에이전트 A', default_preset: 'model-a' }] }),
  listModelPresets: jest.fn().mockResolvedValue({ model_presets: [{ id: 'model-a', label: '모델 A', available: true }] }),
};
const EMPTY = { nodeId: null, agentId: null, modelPreset: null };
afterEach(() => jest.restoreAllMocks());

test('칸 순서는 노드, 에이전트, 모델이고 값은 표시 이름이다', async () => {
  const screen = render(<FolderDefaultsFields api={api as never}
    initial={{ nodeId: 'node-a', agentId: 'agent-a', modelPreset: 'model-a' }} onChange={jest.fn()} />);
  await act(async () => {});
  const rows = within(screen.getByTestId('folder-defaults-fields')).getAllByRole('button');
  expect(rows.map((row) => row.props.accessibilityLabel)).toEqual(['기본 노드', '기본 에이전트', '기본 모델']);
  expect(screen.getByText('에이전트 A')).toBeTruthy();
  expect(screen.getByText('모델 A')).toBeTruthy();
  expect(screen.queryByText('agent-a')).toBeNull();
});

test('기본 노드를 자동으로 고르지 않고, 다 고르기 전에는 저장할 수 없는 값으로 알린다', async () => {
  useSettingsStore.setState({ nodeId: 'node-a' });
  const onChange = jest.fn();
  render(<FolderDefaultsFields api={api as never} initial={EMPTY} onChange={onChange} />);
  await act(async () => {});
  expect(onChange).toHaveBeenLastCalledWith({ value: EMPTY, valid: false });
});

test('노드를 바꾸면 에이전트를 다시 고르게 하고, 모델 미지정은 그대로 둔다', async () => {
  const onChange = jest.fn();
  jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions')
    .mockImplementationOnce((_options, callback) => callback(2))
    .mockImplementationOnce((_options, callback) => callback(1));
  const screen = render(<FolderDefaultsFields api={api as never} initial={{ nodeId: 'node-a', agentId: 'agent-a', modelPreset: null }} onChange={onChange} />);
  await waitFor(() => expect(onChange).toHaveBeenLastCalledWith({ value: { nodeId: 'node-a', agentId: 'agent-a', modelPreset: null }, valid: true }));
  fireEvent.press(screen.getByTestId('folder-defaults-node'));
  await waitFor(() => expect(onChange).toHaveBeenLastCalledWith({ value: { nodeId: 'node-b', agentId: null, modelPreset: null }, valid: false }));
  fireEvent.press(screen.getByTestId('folder-defaults-agent'));
  await waitFor(() => expect(onChange).toHaveBeenLastCalledWith({ value: { nodeId: 'node-b', agentId: 'agent-a', modelPreset: null }, valid: true }));
});

test('소진된 모델도 폴더 기본값으로 고를 수 있다', async () => {
  const onChange = jest.fn();
  const exhaustedApi = { ...api, listModelPresets: jest.fn().mockResolvedValue({
    model_presets: [{ id: 'model-a', label: '모델 A', available: true, reason: 'quota_exhausted' }],
  }) };
  jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((_options, callback) => callback(1));
  const screen = render(<FolderDefaultsFields api={exhaustedApi as never}
    initial={{ nodeId: 'node-a', agentId: 'agent-a', modelPreset: null }} onChange={onChange} />);
  await waitFor(() => expect(exhaustedApi.listModelPresets).toHaveBeenCalled());
  act(() => fireEvent.press(screen.getByTestId('folder-defaults-model')));
  await waitFor(() => expect(onChange).toHaveBeenLastCalledWith({ value: { nodeId: 'node-a', agentId: 'agent-a', modelPreset: 'model-a' }, valid: true }));
});
