import React from 'react';
import { fireEvent, render, within } from '@testing-library/react-native';
import { useSettingsStore } from '../../store/settingsStore';
import { ReviewAttachments } from '../ReviewAttachments';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('../../lib/attachment-image-size', () => ({
  getAttachmentImageSize: jest.fn(() => new Promise(() => {})),
}));

beforeEach(() => {
  useSettingsStore.setState({ serverUrl: 'https://review.test' });
});

test('component review registers the production image and file attachment states', () => {
  const screen = render(<ReviewAttachments />);

  expect(screen.getByTestId('review-attachments-multiple')).toBeTruthy();
  expect(screen.getByTestId('review-attachments-single')).toBeTruthy();
  expect(screen.getByTestId('review-attachments-image-failure')).toBeTruthy();
  expect(within(screen.getByTestId('review-attachments-multiple')).getByLabelText('표본 첫 이미지.png 크게 보기')).toBeTruthy();
  for (const kind of ['user', 'assistant', 'manuscript']) {
    const mixed = within(screen.getByTestId(`review-attachments-mixed-${kind}`));
    expect(mixed.getByLabelText('표본 첫 이미지.png 크게 보기')).toBeTruthy();
    expect(mixed.getByText('수백 줄 서버 로그와 아주 긴 파일 이름을 가진 공개 검수용 첨부 문서.txt')).toBeTruthy();
    expect(mixed.getByText('archive.bin')).toBeTruthy();
  }
  expect(screen.getByLabelText('표본 한 장 이미지.png 크게 보기')).toBeTruthy();
  expect(screen.getByLabelText('불러오지 못하는 이미지.png 크게 보기')).toBeTruthy();

  const files = within(screen.getByTestId('review-attachments-files'));
  for (const name of [
    '메모.txt', 'README.md', '설정.json', '빈 파일.txt', '첨부 없음.txt',
    '권한 없음.txt', '일시 오류.txt', 'archive.bin', 'vector.svg', 'photo.heic',
  ]) expect(files.getByText(name)).toBeTruthy();
  expect(files.getByText('찾을 수 없음')).toBeTruthy();
  expect(files.getByText('0 B')).toBeTruthy();
  expect(files.queryByText('text/plain')).toBeNull();
  expect(files.queryByText('application/octet-stream')).toBeNull();
});

test('component review registers truncated tool success, storage failure, and assistant states', () => {
  const screen = render(<ReviewAttachments />);

  const attached = within(screen.getByTestId('review-attachments-truncation-attached'));
  fireEvent.press(attached.getByTestId('tool-event-header-touch'));
  expect(attached.getByTestId('tool-event-input-truncation-metadata')).toBeTruthy();
  expect(attached.getByTestId('tool-event-result-truncation-metadata')).toBeTruthy();
  expect(attached.getAllByText(/잘림 · 전체 1\.2 MB ·/)).toHaveLength(2);
  expect(attached.getAllByText('전문 열기')).toHaveLength(2);

  const failed = within(screen.getByTestId('review-attachments-truncation-failed'));
  fireEvent.press(failed.getByTestId('tool-event-header-touch'));
  expect(failed.getByText(/잘림 · 전체 1\.2 MB · 전문 보관 실패/)).toBeTruthy();
  expect(failed.queryByText('전문 열기')).toBeNull();

  const assistant = within(screen.getByTestId('review-attachments-truncation-assistant'));
  expect(assistant.getByText(/잘림 · 전체 1\.2 MB/)).toBeTruthy();
  expect(assistant.getByText('전문 열기').props.accessibilityRole).toBe('link');

  const thinkingDefaultAttached = within(screen.getByTestId('review-attachments-truncation-thinking-default-attached'));
  fireEvent.press(thinkingDefaultAttached.getByText('생각 중...'));
  expect(thinkingDefaultAttached.getByText('전문 열기').props.accessibilityRole).toBe('link');
  const thinkingDefaultFailed = within(screen.getByTestId('review-attachments-truncation-thinking-default-failed'));
  fireEvent.press(thinkingDefaultFailed.getByText('생각 중...'));
  expect(thinkingDefaultFailed.getByText(/전문 보관 실패/)).toBeTruthy();
  expect(thinkingDefaultFailed.queryByText('전문 열기')).toBeNull();

  const thinkingManuscriptAttached = within(screen.getByTestId('review-attachments-truncation-thinking-manuscript-attached'));
  expect(thinkingManuscriptAttached.getByText('전문 열기').props.accessibilityRole).toBe('link');
  const thinkingManuscriptFailed = within(screen.getByTestId('review-attachments-truncation-thinking-manuscript-failed'));
  expect(thinkingManuscriptFailed.getByText(/전문 보관 실패/)).toBeTruthy();
  expect(thinkingManuscriptFailed.queryByText('전문 열기')).toBeNull();
});
