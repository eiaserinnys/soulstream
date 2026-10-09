import { Image, type ImageSize, type ImageURISource } from 'react-native';

export function getAttachmentImageSize(source: ImageURISource): Promise<ImageSize> {
  if (!source.uri) return Promise.reject(new Error('Image source has no URI'));
  return Image.getSizeWithHeaders(source.uri, source.headers ?? {});
}
