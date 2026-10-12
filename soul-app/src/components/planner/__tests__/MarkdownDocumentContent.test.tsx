import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import type { ApiClient } from '../../../api/client';
import { MarkdownDocumentContent } from '../MarkdownDocumentContent';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));
jest.mock('../../../theme/useDeviceType', () => ({
  ...jest.requireActual('../../../theme/useDeviceType'),
  useDeviceType: () => 'phone',
}));
jest.mock('../PlannerMarkdownText', () => {
  const { Text } = require('react-native');
  return { PlannerMarkdownText: ({ markdown, testID }: { markdown: string; testID?: string }) =>
    <Text testID={testID}>{markdown}</Text> };
});

const initialDocument = { id: 'doc-1', title: '계획 문서', body: '# 오늘의 계획', version: 3 };

function api(overrides: Record<string, unknown> = {}) {
  return {
    getMarkdownDocument: jest.fn().mockResolvedValue(initialDocument),
    ...overrides,
  } as unknown as ApiClient;
}

test('초기 문서가 있으면 제목과 본문만 표시하고 API를 다시 읽지 않는다', () => {
  const getMarkdownDocument = jest.fn();
  const onClose = jest.fn();
  const screen = render(<MarkdownDocumentContent
    api={api({ getMarkdownDocument })}
    documentId="doc-1"
    initialDocument={initialDocument}
    onClose={onClose}
  />);

  expect(screen.getByTestId('markdown-document-title').props.children).toBe('계획 문서');
  expect(screen.getByTestId('markdown-document-body').props.children).toBe('# 오늘의 계획');
  expect(getMarkdownDocument).not.toHaveBeenCalled();
  fireEvent.press(screen.getByLabelText('뒤로'));
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('문서 ID만 있으면 조회 후 제목과 본문을 표시한다', async () => {
  const client = api();
  const screen = render(<MarkdownDocumentContent api={client} documentId="doc-1" onClose={jest.fn()} />);

  expect(screen.getByTestId('markdown-document-loading')).toBeTruthy();
  await waitFor(() => expect(screen.getByTestId('markdown-document-title').props.children).toBe('계획 문서'));
  expect(client.getMarkdownDocument).toHaveBeenCalledWith('doc-1');
  expect(screen.getByTestId('markdown-document-body').props.children).toBe('# 오늘의 계획');
});

test('조회 실패는 한 줄 오류를 표시한다', async () => {
  const client = api({ getMarkdownDocument: jest.fn().mockRejectedValue(new Error('not found')) });
  const screen = render(<MarkdownDocumentContent api={client} documentId="missing" onClose={jest.fn()} />);

  await act(async () => { await Promise.resolve(); });
  await waitFor(() => expect(screen.getByTestId('markdown-document-error').props.children).toBe('문서를 불러오지 못했습니다.'));
  expect(screen.queryByTestId('markdown-document-body')).toBeNull();
});
