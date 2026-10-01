import React from 'react';
import { Modal } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { ApiHttpError } from '../../../api/clientCore';
import type { PlannerFolder } from '../../../api/plannerTypes';
import { MorningReviewSheet } from '../MorningReviewSheet';

test('loading→action error 격리→retry→complete 흐름과 VoiceOver 순서를 보존한다', async () => {
  const reviewFolder = folder('review-1', '어제 남은 업무');
  const api = plannerApi(reviewFolder);
  const onAction = jest.fn()
    .mockRejectedValueOnce(new Error('mutation failed'))
    .mockResolvedValue(undefined);
  const screen = render(<MorningReviewSheet
    visible
    api={api as any}
    today="2026-07-20"
    onClose={jest.fn()}
    onAction={onAction}
  />);

  expect(screen.getByTestId('morning-review-loading')).toBeTruthy();
  await waitFor(() => expect(screen.getByText('어제 남은 업무')).toBeTruthy());
  expect(screen.UNSAFE_getByType(Modal).props).toMatchObject({
    transparent: true,
    presentationStyle: 'overFullScreen',
  });
  expect(screen.getByTestId('morning-review-modal')).toBeTruthy();
  expect(screen.getByText('1 / 1').props.accessibilityLabel).toBe('오늘 작업 검토 진행률');

  fireEvent.press(screen.getByTestId('morning-review-today'));
  await waitFor(() => expect(screen.getByTestId('morning-review-action-error').props.children)
    .toBe('mutation failed'));
  expect(screen.getByText('어제 남은 업무')).toBeTruthy();

  fireEvent.press(screen.getByTestId('morning-review-today'));
  await waitFor(() => expect(screen.getByTestId('morning-review-complete')).toBeTruthy());
  expect(onAction).toHaveBeenNthCalledWith(1, expect.objectContaining({ folder: reviewFolder }), 'today');
  expect(onAction).toHaveBeenNthCalledWith(2, expect.objectContaining({ folder: reviewFolder }), 'today');
});

test('load error retry와 중도 닫기 뒤 재진입은 항상 최신 queue를 다시 읽는다', async () => {
  const first = folder('first', '첫 업무');
  const latest = folder('latest', '최신 업무');
  let historical = first;
  const api = plannerApi(first);
  api.getDailyHistory.mockRejectedValueOnce(new Error('network'));
  api.getPlannerToday.mockImplementation(async (date: string) => ({
    folders: date === '2026-07-20' ? [] : [historical],
  }));
  const props = {
    visible: true,
    api: api as any,
    today: '2026-07-20',
    onClose: jest.fn(),
    onAction: jest.fn().mockResolvedValue(undefined),
  };
  const screen = render(<MorningReviewSheet {...props} />);
  await waitFor(() => expect(screen.getByTestId('morning-review-load-error')).toBeTruthy());
  fireEvent.press(screen.getByTestId('morning-review-retry'));
  await waitFor(() => expect(screen.getByText('첫 업무')).toBeTruthy());

  screen.rerender(<MorningReviewSheet {...props} visible={false} />);
  historical = latest;
  screen.rerender(<MorningReviewSheet {...props} visible />);
  await waitFor(() => expect(screen.getByText('최신 업무')).toBeTruthy());
  expect(api.getDailyHistory).toHaveBeenCalledTimes(3);
});

test.each([
  [401, '로그인은 유지했습니다. 서버가 완료 처리 사용자를 확인하지 못했습니다.'],
  [403, '이 카드를 완료할 권한이 없습니다.'],
  [422, '서버가 이 카드의 완료 경로를 확인하지 못했습니다.'],
  [500, 'completion 500'],
] as const)('완료 실패 HTTP %i를 사용자가 구분할 수 있는 문구로 표시한다', async (
  status,
  expected,
) => {
  const reviewFolder = folder(`review-${status}`, '완료할 업무');
  const api = plannerApi(reviewFolder);
  const onAction = jest.fn().mockRejectedValue(
    new ApiHttpError(`completion ${status}`, status, ''),
  );
  const screen = render(<MorningReviewSheet
    visible
    api={api as any}
    today="2026-07-20"
    onClose={jest.fn()}
    onAction={onAction}
  />);

  await waitFor(() => expect(screen.getByText('완료할 업무')).toBeTruthy());
  fireEvent.press(screen.getByTestId('morning-review-done'));

  await waitFor(() => expect(
    screen.getByTestId('morning-review-action-error').props.children,
  ).toBe(expected));
});

function plannerApi(historical: PlannerFolder) {
  return {
    getDailyHistory: jest.fn().mockResolvedValue({ dates: ['2026-07-19'] }),
    getPlannerToday: jest.fn(async (date: string) => ({
      folders: date === '2026-07-20' ? [] : [historical],
    })),
  };
}

function folder(id: string, title: string): PlannerFolder {
  return {
    page: { id, title, dailyDate: null, version: 1, archived: false, metadata: {}, createdAt: '', updatedAt: '' },
    blocks: [], folderId: id,
    folderSummary: {
      id, title, status: 'open', archived: false, version: 1,
      itemCounts: {}, itemTotal: 0, completedItemCount: 0, assignee: null,
    },
    status: 'open', assignee: '', contextCount: 0, progress: null,
    projectPageId: null, sessions: [], sessionIds: [],
  };
}
