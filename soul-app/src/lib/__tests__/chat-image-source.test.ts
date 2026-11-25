import { chatImageSource } from '../chat-image-source';
import { Image } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { getAttachmentImageSize as getNativeAttachmentImageSize } from '../attachment-image-size.native';
import { getAttachmentImageSize as getWebAttachmentImageSize } from '../attachment-image-size.web';

afterEach(() => jest.restoreAllMocks());
beforeEach(() => (ExpoImage.loadAsync as jest.Mock).mockClear());

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

const diskUri = 'https://soulstream.eiaserinnys.me/api/attachments/att-1/content';
const memoryUri = 'https://soulstream.eiaserinnys.me/api/attachments/files?path=%2Fimage.png';

test('native size lookup uses expo-image loadAsync for disk-cached addresses with the same URI and headers', async () => {
  const source = { uri: diskUri, headers: { Authorization: 'Bearer test-jwt' } };
  const loadAsync = jest.spyOn(ExpoImage, 'loadAsync') as jest.Mock;
  loadAsync.mockImplementation(() => Promise.resolve({ width: 390, height: 844 }));
  const legacy = jest.spyOn(Image, 'getSizeWithHeaders');

  await expect(getNativeAttachmentImageSize(source)).resolves.toEqual({ width: 390, height: 844 });
  expect(loadAsync).toHaveBeenCalledWith({ uri: source.uri, headers: source.headers });
  expect(legacy).not.toHaveBeenCalled();
});

test('native size lookup sends no headers to loadAsync when the disk-cached source has none', async () => {
  const source = { uri: diskUri };
  const loadAsync = jest.spyOn(ExpoImage, 'loadAsync') as jest.Mock;
  loadAsync.mockImplementation(() => Promise.resolve({ width: 390, height: 844 }));

  await expect(getNativeAttachmentImageSize(source)).resolves.toEqual({ width: 390, height: 844 });
  expect(loadAsync).toHaveBeenCalledWith({ uri: source.uri });
});

test('native size lookup keeps getSizeWithHeaders for memory-cached addresses so no stale disk size is read', async () => {
  const source = { uri: memoryUri, headers: { Authorization: 'Bearer test-jwt' } };
  const loadAsync = jest.spyOn(ExpoImage, 'loadAsync') as jest.Mock;
  const legacy = jest.spyOn(Image, 'getSizeWithHeaders').mockImplementation(() => Promise.resolve({ width: 120, height: 80 }));

  await expect(getNativeAttachmentImageSize(source)).resolves.toEqual({ width: 120, height: 80 });
  expect(legacy).toHaveBeenCalledWith(source.uri, source.headers);
  expect(loadAsync).not.toHaveBeenCalled();
});

test('native size lookup sends empty headers to getSizeWithHeaders when a memory-cached source has none', async () => {
  const source = { uri: 'https://images.example/image.png' };
  const legacy = jest.spyOn(Image, 'getSizeWithHeaders').mockImplementation(() => Promise.resolve({ width: 5, height: 6 }));

  await expect(getNativeAttachmentImageSize(source)).resolves.toEqual({ width: 5, height: 6 });
  expect(legacy).toHaveBeenCalledWith(source.uri, {});
});

test('web size lookup resolves callback dimensions when Image.getSize returns undefined', async () => {
  const source = chatImageSource('/api/attachments/files?path=%2Fimage.png', serverUrl, jwt, 'web');
  const getSize = jest.spyOn(Image, 'getSize');
  getSize.mockImplementation((_uri, success) => {
    success(390, 844);
    return undefined;
  });

  await expect(getWebAttachmentImageSize(source)).resolves.toEqual({ width: 390, height: 844 });
  expect(getSize).toHaveBeenCalledWith(source.uri, expect.any(Function), expect.any(Function));
});

test('web size lookup rejects when the callback reports a request failure', async () => {
  const source = chatImageSource('/api/attachments/files?path=%2Fimage.png', serverUrl, jwt, 'web');
  const failure = new Error('unauthorized');
  const getSize = jest.spyOn(Image, 'getSize');
  getSize.mockImplementation((_uri, _success, onFailure) => {
    onFailure?.(failure);
    return undefined;
  });

  await expect(getWebAttachmentImageSize(source)).rejects.toBe(failure);
  expect(getSize).toHaveBeenCalledWith(source.uri, expect.any(Function), expect.any(Function));
});
