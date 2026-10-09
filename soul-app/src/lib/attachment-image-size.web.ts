import { Image, type ImageSize, type ImageURISource } from 'react-native';

export function getAttachmentImageSize(source: ImageURISource): Promise<ImageSize> {
  const uri = source.uri;
  if (!uri) return Promise.reject(new Error('Image source has no URI'));
  return new Promise<ImageSize>((resolve, reject) => {
    Image.getSize(uri, (width, height) => resolve({ width, height }), reject);
  });
}
