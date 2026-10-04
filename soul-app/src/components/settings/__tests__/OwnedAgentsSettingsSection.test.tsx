import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { OwnedAgentsSettingsSection } from '../OwnedAgentsSettingsSection';
import * as Clipboard from 'expo-clipboard';
import type { OwnedAgent, OwnedAgentKey } from '../../../api/ownedAgentsEndpoints';
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn().mockResolvedValue(undefined) }));

const credential: OwnedAgentKey = { id: 'k1', createdAt: '2026-10-04T00:00:00Z', lastUsedAt: null, revokedAt: null, isExistingConnection: true };
const agent: OwnedAgent = { id: 'a1', name: '내 도우미', enabled: true, ownerEmail: 'hidden@example.test', createdAt: credential.createdAt, updatedAt: credential.createdAt, keys: [credential] };
function fixture() {
  let agents: typeof agent[] = [];
  let registered = false;
  const api = {
    listOwnedAgents: jest.fn(async () => ({ agents, existingConnection: { configured: true, registered, canRegister: !registered } })),
    createOwnedAgent: jest.fn(async ({ name }: { name: string }) => { agents = [{ ...agent, name }]; return { agent: agents[0] }; }),
    updateOwnedAgent: jest.fn(async (_id: string, patch: object) => { agents = [{ ...agents[0], ...patch }]; return { agent: agents[0] }; }),
    registerExistingOwnedAgent: jest.fn(async () => { agents = [agent]; registered = true; return { agent, credential }; }),
    issueOwnedAgentKey: jest.fn(async () => ({ credential, token: 'fake-once-token' })),
    revokeOwnedAgentKey: jest.fn(async () => { agents = [{ ...agent, keys: [{ ...credential, revokedAt: credential.createdAt }] }]; }),
  };
  return api;
}

test('registers, issues, copies, discards on close, and revokes with confirmation', async () => {
  const api = fixture();
  const screen = render(<OwnedAgentsSettingsSection flattened api={api} />);
  expect(await screen.findByText('아직 등록한 에이전트가 없습니다.')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('기존 연결 등록'));
  expect(await screen.findByText('내 도우미')).toBeTruthy();
  expect(screen.queryByText(agent.ownerEmail)).toBeNull();
  fireEvent.press(screen.getByLabelText('새 키 발급'));
  expect(await screen.findByText('fake-once-token')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('복사'));
  await waitFor(() => expect(Clipboard.setStringAsync).toHaveBeenCalledWith('fake-once-token'));
  fireEvent.press(screen.getByLabelText('닫기'));
  expect(screen.queryByText('fake-once-token')).toBeNull();
  fireEvent.press(screen.getByLabelText('키 폐기'));
  fireEvent.press(screen.getByLabelText('폐기'));
  expect(await screen.findByText(/폐기됨/)).toBeTruthy();
});

test('preserves failed name input, retries, renames and toggles', async () => {
  const api = fixture();
  const screen = render(<OwnedAgentsSettingsSection flattened={false} api={api} />);
  await screen.findByText('아직 등록한 에이전트가 없습니다.');
  fireEvent.press(screen.getByLabelText('에이전트 추가'));
  fireEvent.changeText(screen.getByLabelText('에이전트 이름'), '새 도우미');
  api.createOwnedAgent.mockRejectedValueOnce(new Error('HTTP 503'));
  fireEvent.press(screen.getByLabelText('저장'));
  await screen.findByText(/HTTP 503/);
  expect(screen.getByLabelText('에이전트 이름').props.value).toBe('새 도우미');
  fireEvent.press(screen.getByLabelText('저장'));
  await screen.findByText('새 도우미');
  fireEvent.press(screen.getByLabelText('이름 변경'));
  fireEvent.changeText(screen.getByLabelText('에이전트 이름'), '바뀐 도우미');
  fireEvent.press(screen.getByLabelText('저장'));
  await screen.findByText('바뀐 도우미');
  fireEvent(screen.getByRole('switch'), 'valueChange', false);
  await waitFor(() => expect(api.updateOwnedAgent).toHaveBeenLastCalledWith('a1', { enabled: false }));
});

test('retry list error and discard pending issuance on leaving the panel', async () => {
  const api = fixture(); api.listOwnedAgents.mockRejectedValueOnce(new Error('HTTP 503'));
  const screen = render(<OwnedAgentsSettingsSection flattened api={api} />);
  await screen.findByText(/HTTP 503/); fireEvent.press(screen.getByLabelText('다시 시도'));
  await screen.findByText('아직 등록한 에이전트가 없습니다.');
  fireEvent.press(screen.getByLabelText('기존 연결 등록')); await screen.findByText('내 도우미');
  let resolve!: (value: { credential: typeof credential; token: string }) => void;
  api.issueOwnedAgentKey.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  const issue = screen.getByLabelText('새 키 발급');
  fireEvent.press(issue); fireEvent.press(issue);
  expect(api.issueOwnedAgentKey).toHaveBeenCalledTimes(1);
  screen.rerender(<OwnedAgentsSettingsSection flattened api={api} active={false} />);
  await act(async () => resolve({ credential, token: 'late-fake-key' }));
  screen.rerender(<OwnedAgentsSettingsSection flattened api={api} />);
  await screen.findByText('내 도우미'); expect(screen.queryByText('late-fake-key')).toBeNull();
});
