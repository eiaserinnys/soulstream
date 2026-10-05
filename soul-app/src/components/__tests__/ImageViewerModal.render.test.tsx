import React from 'react';
import { Modal } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { ImageViewerModal } from '../ImageViewerModal';
import { AttachmentImage } from '../AttachmentImage';

test('full-screen image modal owns its safe area outside the header and scrolling image', () => {
  const onClose = jest.fn();
  const screen = render(<ImageViewerModal sources={[{ uri: 'https://test/photo.png' }]} initialIndex={0} onClose={onClose} />);
  const modal = screen.UNSAFE_getByType(Modal);
  expect(modal.props.children.type).toBe(SafeAreaProvider);
  expect(modal.props.children.props.initialMetrics).toBeUndefined();
  expect(modal.props.children.props.children.type).toBe(SafeAreaView);
  expect(modal.props).toMatchObject({ transparent: true, presentationStyle: 'overFullScreen', onRequestClose: onClose });
  fireEvent.press(screen.getByLabelText('이미지 닫기'));
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('closing an attachment leaves its original thumbnail available', () => {
  const screen = render(<AttachmentImage source={{ uri: 'https://test/photo.png' }} accessibilityLabel="첨부 사진" />);
  fireEvent.press(screen.getByLabelText('첨부 사진'));
  expect(screen.getByTestId('image-viewer-pages')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('이미지 닫기'));
  expect(screen.queryByTestId('image-viewer-pages')).toBeNull();
  expect(screen.getByLabelText('첨부 사진')).toBeTruthy();
});

test('캡션은 해당 이미지 페이지 아래에만 나타나고 기본 첨부는 그대로다', () => {
  const screen = render(<AttachmentImage source={{ uri: 'https://test/one.png' }}
    sources={[{ uri: 'https://test/one.png' }, { uri: 'https://test/two.png' }]}
    captions={['첫 화면', '둘째 화면']} accessibilityLabel="첫 화면 썸네일" />);
  expect(screen.queryByText('첫 화면')).toBeNull();
  fireEvent.press(screen.getByLabelText('첫 화면 썸네일'));
  expect(screen.getByTestId('image-viewer-caption-0').props.children).toBe('첫 화면');
  expect(screen.getByTestId('image-viewer-caption-1').props.children).toBe('둘째 화면');
});
