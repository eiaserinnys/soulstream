import React from 'react';
import { Image } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import { ImageViewerPages } from '../ImageViewerPages';

test('페이지 스크롤은 확대 영역을 유지하고 이동한 인덱스를 알린다', () => {
  const onIndexChange = jest.fn();
  const screen = render(<ImageViewerPages
    sources={[{ uri: 'https://test/one.png' }, { uri: 'https://test/two.png' }]}
    currentIndex={0}
    onIndexChange={onIndexChange}
  />);
  const pages = screen.getByTestId('image-viewer-pages');

  expect(pages.props).toMatchObject({ horizontal: true, pagingEnabled: true });
  expect(screen.getAllByTestId('image-viewer-zoom')).toHaveLength(2);
  expect(screen.getAllByTestId('image-viewer-zoom')[0].props).toMatchObject({
    minimumZoomScale: 1,
    maximumZoomScale: 3,
    centerContent: true,
  });
  fireEvent(pages, 'momentumScrollEnd', {
    nativeEvent: { contentOffset: { x: 390, y: 0 }, layoutMeasurement: { width: 390 } },
  });
  expect(onIndexChange).toHaveBeenCalledWith(1);
});

test('실패한 이미지는 페이지 칸을 유지하고 같은 위치에 짧은 상태를 보인다', () => {
  const screen = render(<ImageViewerPages
    sources={[{ uri: 'https://test/one.png' }, { uri: 'https://test/two.png' }]}
    currentIndex={0}
    onIndexChange={jest.fn()}
  />);
  const images = screen.UNSAFE_getAllByType(Image);

  fireEvent(images[0], 'error');
  expect(screen.getByText('불러오지 못함')).toBeTruthy();
  expect(screen.getByTestId('image-viewer-page-0')).toBeTruthy();
  expect(screen.getByTestId('image-viewer-page-1')).toBeTruthy();
});
