import { chatImageSource } from '../chat-image-source';
import { Image } from 'react-native';
import { getAttachmentImageSize as getNativeAttachmentImageSize } from '../attachment-image-size.native';
import { getAttachmentImageSize as getWebAttachmentImageSize } from '../attachment-image-size.web';

const serverUrl = 'https://soulstream.eiaserinnys.me';
const jwt = 'test-jwt';

test('native same-origin chat images reuse the existing Bearer source', () => {
  expect(chatImageSource('/api/attachments/files?path=%2Fimage.png', serverUrl, jwt, 'ios')).toEqual({
    uri: 'https://soulstream.eiaserinnys.me/api/attachments/files?path=%2Fimage.png',
    headers: { Authorization: 'Bearer test-jwt' },
  });
});

test('external chat images never receive the Bearer header', () => {
  expect(chatImageSource('https://images.example/image.png', serverUrl, jwt, 'android')).toEqual({
    uri: 'https://images.example/image.png',
  });
});

test('web chat images keep the original URL and use browser authentication', () => {
  expect(chatImageSource('/api/attachments/files?path=%2Fimage.png', serverUrl, jwt, 'web')).toEqual({
    uri: 'https://soulstream.eiaserinnys.me/api/attachments/files?path=%2Fimage.png',
  });
});

test('native size lookup receives the same URI and headers as its image source', async () => {
  const source = chatImageSource('/api/attachments/files?path=%2Fimage.png', serverUrl, jwt, 'ios');
  const getSizeWithHeaders = jest.spyOn(Image, 'getSizeWithHeaders');
  getSizeWithHeaders.mockImplementation(() => Promise.resolve({ width: 390, height: 844 }));

  await expect(getNativeAttachmentImageSize(source)).resolves.toEqual({ width: 390, height: 844 });
  expect(getSizeWithHeaders).toHaveBeenCalledWith(source.uri, source.headers);
  getSizeWithHeaders.mockRestore();
});

test('native size lookup uses getSizeWithHeaders with an empty header map when the source has no headers', async () => {
  const source = { uri: 'https://images.example/image.png' };
  const getSizeWithHeaders = jest.spyOn(Image, 'getSizeWithHeaders');
  getSizeWithHeaders.mockImplementation(() => Promise.resolve({ width: 390, height: 844 }));

  await expect(getNativeAttachmentImageSize(source)).resolves.toEqual({ width: 390, height: 844 });
  expect(getSizeWithHeaders).toHaveBeenCalledWith(source.uri, {});
  getSizeWithHeaders.mockRestore();
});

test('web size lookup uses Image.getSize with the original URI', async () => {
  const source = chatImageSource('/api/attachments/files?path=%2Fimage.png', serverUrl, jwt, 'web');
  const getSize = jest.spyOn(Image, 'getSize');
  getSize.mockImplementation(() => Promise.resolve({ width: 390, height: 844 }));

  await expect(getWebAttachmentImageSize(source)).resolves.toEqual({ width: 390, height: 844 });
  expect(getSize).toHaveBeenCalledWith(source.uri);
  getSize.mockRestore();
});
