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
