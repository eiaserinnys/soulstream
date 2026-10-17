import React from 'react';
import { render, within } from '@testing-library/react-native';
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
