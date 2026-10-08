import React from 'react';
import { Text } from 'react-native';
import { render, waitFor } from '@testing-library/react-native';
import { chatImageSource } from '../../../lib/chat-image-source';
import { formatChatImageMetadata, useChatImageMetadata, type ChatRefinedGalleryItem } from '../../AttachmentImage';

const serverUrl = 'https://soulstream.eiaserinnys.me';
const fetchMock = jest.fn();
const originalFetch = global.fetch;

function MetadataHarness({ source }: { source: ChatRefinedGalleryItem['source'] }) {
  const images = useChatImageMetadata([{ source, filename: 'path-image.png' }], serverUrl);
  const image = images[0];
  return <Text testID="metadata-value">{`${image.filename}|${image.mimeType ?? ''}|${image.byteSize ?? ''}`}</Text>;
}

beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue({
    ok: true,
    headers: {
      get: (name: string) => ({
        'content-disposition': 'attachment; filename="server-image.png"',
        'content-type': 'image/png; charset=binary',
        'content-length': '62341',
      }[name.toLowerCase()] ?? null),
    },
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

test('메타 HEAD는 기존 보호 이미지 source를 사용하고 응답에 있는 값만 보강한다', async () => {
  const source = chatImageSource('/api/attachments/files?path=%2Fpath-image.png', serverUrl, 'metadata-test-jwt', 'ios');
  const screen = render(<MetadataHarness source={source} />);

  await waitFor(() => expect(screen.getByTestId('metadata-value').props.children)
    .toBe('server-image.png|image/png|62341'));
  expect(fetchMock).toHaveBeenCalledWith(source.uri, expect.objectContaining({ method: 'HEAD' }));
  if (source.headers) expect(fetchMock.mock.calls[0][1].headers).toBe(source.headers);
  expect(formatChatImageMetadata('image/png', 62341)).toMatch(/image\/png.*62,341 bytes/);
});

test.each([
  'https://images.example/image.png',
  `${serverUrl}/assets/images/public.png`,
])('메타 HEAD는 보호 파일 경로 밖의 이미지에 요청하지 않는다: %s', (uri) => {
  const screen = render(<MetadataHarness source={{ uri }} />);
  expect(screen.getByTestId('metadata-value').props.children).toBe('path-image.png||');
  expect(fetchMock).not.toHaveBeenCalled();
});
