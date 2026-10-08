import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { ApiHttpError } from '../../../api/clientCore';
import type { PersistentSessionInstruction } from '../../../api/persistentSessionEndpoints';
import { createApiClient } from '../../../api/client';
import { useAuthStore } from '../../../store/authStore';
import { describePersistentFailure } from '../persistentSessionFailure';
import { PersistentSessionApiProvider } from '../persistentSessionApi';
import { PersistentSessionInstructions } from '../PersistentSessionInstructions';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');

afterEach(() => {
  jest.restoreAllMocks();
  useAuthStore.setState({ jwt: null, authRejected: false });
});

const records: PersistentSessionInstruction[] = [
  { id: 'instruction-1', text: 'Check the requested scope first.', source_turns: ['T195', 'T210'], created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-06T00:00:00Z', origin: 'user' },
  { id: 'instruction-2', text: 'Report the result briefly.', source_turns: [], created_at: '2026-10-02T00:00:00Z', updated_at: '2026-10-05T00:00:00Z', origin: 'user' },
];

function response(body: unknown, status = 200) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 409 ? 'Conflict' : 'OK',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: async () => body,
    text: async () => text,
  } as Response;
}

function setup(overrides: Record<string, jest.Mock> = {}) {
  const api = {
    getPersistentSessionInstructions: jest.fn().mockResolvedValue({ instructions: records }),
    createPersistentSessionInstruction: jest.fn().mockImplementation(async (_sessionId: string, text: string) => ({
      instruction: { id: 'instruction-new', text, source_turns: [], created_at: '2026-10-07T00:00:00Z', updated_at: '2026-10-07T00:00:00Z', origin: 'user' },
    })),
    updatePersistentSessionInstruction: jest.fn().mockImplementation(async (_sessionId: string, id: string, input: { text?: string; status?: string }) => ({
      instruction: { ...records.find((item) => item.id === id)!, ...(input.text ? { text: input.text } : {}), ...(input.status ? { status: input.status } : {}) },
    })),
    ...overrides,
  };
  const screen = render(
    <PersistentSessionApiProvider createApi={() => api as never}>
      <PersistentSessionInstructions serverUrl="https://soul.test" sessionId="pas-1" />
    </PersistentSessionApiProvider>,
  );
  return { screen, api };
}

test('loads instruction rows, edits, adds and removes them through the API action path', async () => {
  const { screen, api } = setup();

  expect(await screen.findByTestId('persistent-instruction-instruction-1')).toBeTruthy();
  expect(screen.getByText('지속 지시')).toBeTruthy();
  expect(screen.getByText(/T195, T210/)).toBeTruthy();
  expect(screen.queryByText('지속 지시 없음')).toBeNull();

  fireEvent.press(screen.getByTestId('persistent-instruction-open-instruction-1'));
  fireEvent.changeText(screen.getByTestId('persistent-instruction-input-instruction-1'), 'Updated instruction.');
  fireEvent.press(screen.getByTestId('persistent-instruction-save-instruction-1'));
  await waitFor(() => expect(api.updatePersistentSessionInstruction).toHaveBeenCalledWith('pas-1', 'instruction-1', { text: 'Updated instruction.' }));
  expect(await screen.findByText('Updated instruction.')).toBeTruthy();

  fireEvent.changeText(screen.getByTestId('persistent-instruction-add-input'), 'New instruction.');
  fireEvent.press(screen.getByTestId('persistent-instruction-add'));
  await waitFor(() => expect(api.createPersistentSessionInstruction).toHaveBeenCalledWith('pas-1', 'New instruction.'));
  expect(await screen.findByText('New instruction.')).toBeTruthy();

  fireEvent.press(screen.getByTestId('persistent-instruction-delete-instruction-2'));
  await waitFor(() => expect(api.updatePersistentSessionInstruction).toHaveBeenCalledWith('pas-1', 'instruction-2', { status: 'removed' }));
  await waitFor(() => expect(screen.queryByTestId('persistent-instruction-instruction-2')).toBeNull());
});

test('cancel keeps the row and saving an empty edit removes it', async () => {
  const { screen, api } = setup();
  await screen.findByTestId('persistent-instruction-instruction-1');

  fireEvent.press(screen.getByTestId('persistent-instruction-open-instruction-1'));
  fireEvent.changeText(screen.getByTestId('persistent-instruction-input-instruction-1'), 'Discard this edit.');
  fireEvent.press(screen.getByTestId('persistent-instruction-cancel-instruction-1'));
  expect(screen.getByText('Check the requested scope first.')).toBeTruthy();
  expect(api.updatePersistentSessionInstruction).not.toHaveBeenCalled();

  fireEvent.press(screen.getByTestId('persistent-instruction-open-instruction-1'));
  fireEvent.changeText(screen.getByTestId('persistent-instruction-input-instruction-1'), '   ');
  fireEvent.press(screen.getByTestId('persistent-instruction-save-instruction-1'));
  await waitFor(() => expect(api.updatePersistentSessionInstruction).toHaveBeenCalledWith('pas-1', 'instruction-1', { status: 'removed' }));
  await waitFor(() => expect(screen.queryByTestId('persistent-instruction-instruction-1')).toBeNull());
});

test('shows the web-matched empty state and cap_reached message from the server response', async () => {
  const api = {
    getPersistentSessionInstructions: jest.fn().mockResolvedValue({ instructions: [] }),
    createPersistentSessionInstruction: jest.fn().mockRejectedValue(new ApiHttpError('cap reached', 409, JSON.stringify({ error: 'cap_reached' }))),
    updatePersistentSessionInstruction: jest.fn(),
  };
  const screen = render(
    <PersistentSessionApiProvider createApi={() => api as never}>
      <PersistentSessionInstructions serverUrl="https://soul.test" sessionId="pas-1" />
    </PersistentSessionApiProvider>,
  );
  expect(await screen.findByText('지속 지시 없음')).toBeTruthy();
  fireEvent.changeText(screen.getByTestId('persistent-instruction-add-input'), 'A capped instruction.');
  fireEvent.press(screen.getByTestId('persistent-instruction-add'));
  expect(await screen.findByText('지속 지시 상한에 도달했습니다.')).toBeTruthy();
});

test('shows instruction-specific guidance for INVALID_REQUEST without changing settings guidance', async () => {
  const invalid = new ApiHttpError('invalid instruction', 400, JSON.stringify({
    error: { code: 'INVALID_REQUEST', message: 'Instruction text is invalid.' },
  }));
  const { screen } = setup({ createPersistentSessionInstruction: jest.fn().mockRejectedValue(invalid) });
  await screen.findByTestId('persistent-instruction-instruction-1');

  fireEvent.changeText(screen.getByTestId('persistent-instruction-add-input'), 'Bad instruction.');
  fireEvent.press(screen.getByTestId('persistent-instruction-add'));

  expect(await screen.findByText('지속 지시 내용을 확인해 주세요.')).toBeTruthy();
  expect(describePersistentFailure(invalid, 'save').text).toBe('입력한 값을 저장할 수 없습니다. 이름과 기본 모델을 확인해 주세요.');
});

test('blocks editing, deleting and adding while a session instruction list is loading', async () => {
  let resolveSecondGet!: (value: { instructions: PersistentSessionInstruction[] }) => void;
  const api = {
    getPersistentSessionInstructions: jest.fn((sessionId: string) => sessionId === 'pas-1'
      ? Promise.resolve({ instructions: records })
      : new Promise<{ instructions: PersistentSessionInstruction[] }>((resolve) => { resolveSecondGet = resolve; })),
    createPersistentSessionInstruction: jest.fn(),
    updatePersistentSessionInstruction: jest.fn(),
  };
  const renderInstructions = (sessionId: string) => (
    <PersistentSessionApiProvider createApi={() => api as never}>
      <PersistentSessionInstructions serverUrl="https://soul.test" sessionId={sessionId} />
    </PersistentSessionApiProvider>
  );
  const screen = render(renderInstructions('pas-1'));
  await screen.findByTestId('persistent-instruction-instruction-1');
  screen.rerender(renderInstructions('pas-2'));
  await waitFor(() => expect(api.getPersistentSessionInstructions).toHaveBeenCalledTimes(2));

  const edit = screen.getByTestId('persistent-instruction-open-instruction-1');
  const remove = screen.getByTestId('persistent-instruction-delete-instruction-1');
  fireEvent.press(edit);
  fireEvent.press(remove);
  fireEvent.press(screen.getByTestId('persistent-instruction-add'));
  expect(screen.queryByTestId('persistent-instruction-edit-instruction-1')).toBeNull();
  expect(api.createPersistentSessionInstruction).not.toHaveBeenCalled();
  expect(api.updatePersistentSessionInstruction).not.toHaveBeenCalled();

  resolveSecondGet({ instructions: [] });
  expect(await screen.findByText('지속 지시 없음')).toBeTruthy();
});

test('keeps a newly added instruction after a delayed initial GET using the API client fetch path', async () => {
  useAuthStore.setState({ jwt: 'test-jwt', authRejected: false });
  let resolveGet!: (value: Response) => void;
  const created: PersistentSessionInstruction = {
    id: 'instruction-new', text: 'New instruction.', source_turns: [],
    created_at: '2026-10-07T00:00:00Z', updated_at: '2026-10-07T00:00:00Z', origin: 'user',
  };
  const fetchMock = jest.spyOn(global, 'fetch')
    .mockImplementationOnce(() => new Promise((resolve) => { resolveGet = resolve; }))
    .mockResolvedValueOnce(response({ instruction: created }, 201));
  const screen = render(
    <PersistentSessionApiProvider createApi={(url) => createApiClient(url)}>
      <PersistentSessionInstructions serverUrl="https://soul.test" sessionId="pas-1" />
    </PersistentSessionApiProvider>,
  );

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  fireEvent.changeText(screen.getByTestId('persistent-instruction-add-input'), 'New instruction.');
  fireEvent.press(screen.getByTestId('persistent-instruction-add'));
  expect(fetchMock).toHaveBeenCalledTimes(1);

  resolveGet(response({ instructions: [records[0]] }));
  expect(await screen.findByTestId('persistent-instruction-instruction-1')).toBeTruthy();
  fireEvent.changeText(screen.getByTestId('persistent-instruction-add-input'), 'New instruction.');
  fireEvent.press(screen.getByTestId('persistent-instruction-add'));

  expect(await screen.findByText('New instruction.')).toBeTruthy();
  expect(screen.getByText('Check the requested scope first.')).toBeTruthy();
  expect(fetchMock.mock.calls.map(([url, init]) => [new URL(String(url)).pathname, init?.method ?? 'GET', init?.body ?? null])).toEqual([
    ['/api/persistent-sessions/pas-1/instructions', 'GET', null],
    ['/api/persistent-sessions/pas-1/instructions', 'POST', JSON.stringify({ text: 'New instruction.' })],
  ]);
});

test('shows the existing retry path when loading fails', async () => {
  const api = {
    getPersistentSessionInstructions: jest.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ instructions: records }),
    createPersistentSessionInstruction: jest.fn(),
    updatePersistentSessionInstruction: jest.fn(),
  };
  const screen = render(
    <PersistentSessionApiProvider createApi={() => api as never}>
      <PersistentSessionInstructions serverUrl="https://soul.test" sessionId="pas-1" />
    </PersistentSessionApiProvider>,
  );
  expect(await screen.findByText('조회 실패')).toBeTruthy();
  fireEvent.press(screen.getByTestId('persistent-instructions-retry'));
  expect(await screen.findByTestId('persistent-instruction-instruction-1')).toBeTruthy();
});
