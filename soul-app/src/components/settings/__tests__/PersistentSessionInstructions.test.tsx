import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { ApiHttpError } from '../../../api/clientCore';
import type { PersistentSessionInstruction } from '../../../api/persistentSessionEndpoints';
import { PersistentSessionApiProvider } from '../persistentSessionApi';
import { PersistentSessionInstructions } from '../PersistentSessionViews';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');

const records: PersistentSessionInstruction[] = [
  { id: 'instruction-1', text: 'Check the requested scope first.', source_turns: ['T195', 'T210'], created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-06T00:00:00Z', origin: 'user' },
  { id: 'instruction-2', text: 'Report the result briefly.', source_turns: [], created_at: '2026-10-02T00:00:00Z', updated_at: '2026-10-05T00:00:00Z', origin: 'user' },
];

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
  expect(screen.getByText(/T195, T210/)).toBeTruthy();
  expect(screen.queryByText('등록된 지속 지시가 없습니다.')).toBeNull();

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

test('shows an empty state and the cap_reached message from the server response', async () => {
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
  expect(await screen.findByText('등록된 지속 지시가 없습니다.')).toBeTruthy();
  fireEvent.changeText(screen.getByTestId('persistent-instruction-add-input'), 'A capped instruction.');
  fireEvent.press(screen.getByTestId('persistent-instruction-add'));
  expect(await screen.findByText('지속 지시를 더 추가할 수 없습니다.')).toBeTruthy();
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
