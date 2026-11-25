
import { Image } from 'expo-image';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import type { AttachmentView } from '../../lib/attachment-view';
import { ImageViewerPages } from '../ImageViewerPages';

jest.mock('react-native-svg', () => ({
  SvgXml: (props: any) => require('react').createElement(require('react-native').View, { testID: 'svg-xml', ...props }),
}));

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

test('SVG 항목은 RN Image 대신 react-native-svg로 그린다', async () => {
  const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => '<svg viewBox="0 0 40 20"><rect width="40" height="20"/></svg>',
  } as unknown as Response);
  const item: AttachmentView = {
    key: 'svg-1',
    name: 'logo.svg',
    mimeType: 'image/svg+xml',
    byteSize: 512,
    previewKind: 'image',
    source: { kind: 'ready', attachmentId: 'svg-1', previewUrl: null, originalUrl: '/api/attachments/svg-1/content' },
  };
  try {
    const screen = render(<ImageViewerPages
      sources={[{ uri: 'https://soul.test/api/attachments/svg-1/content' }]}
      items={[item]}
      mimeTypes={['image/svg+xml']}
      currentIndex={0}
      onIndexChange={jest.fn()}
    />);

    expect(screen.getByTestId('image-viewer-svg-0')).toBeTruthy();
    expect(screen.queryByTestId('image-viewer-image-0')).toBeNull();
    fireEvent(screen.getByTestId('image-viewer-svg-0'), 'layout', {
      nativeEvent: { layout: { width: 200, height: 200 } },
    });
    await waitFor(() => expect(screen.getByTestId('svg-xml')).toBeTruthy());
    expect(screen.getByTestId('svg-xml').props.xml).toContain('<svg');
  } finally {
    fetchMock.mockRestore();
  }
});
