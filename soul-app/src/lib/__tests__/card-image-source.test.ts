import { cardImageSource } from '../card-image-source';

const server = 'https://cards.test';
const jwt = 'public-test-token';

test.each([
  ['/api/attachments/files?nodeId=n&path=%2Ftmp%2Fphoto.png', server + '/api/attachments/files?nodeId=n&path=%2Ftmp%2Fphoto.png', true],
  [server + '/photo.png', server + '/photo.png', true],
  ['https://other.test/photo.png', 'https://other.test/photo.png', false],
  ['//other.test/photo.png', 'https://other.test/photo.png', false],
])('이미지 source는 실제 출처를 비교한다: %s', (url, uri, authorized) => {
  const source = cardImageSource(url, server, jwt);
  expect(source.uri).toBe(uri);
  expect(Boolean(source.headers?.Authorization)).toBe(authorized);
  if (authorized) expect(source.headers?.Authorization === `Bearer ${jwt}`).toBe(true);
});

test('로그아웃이면 인증 헤더를 만들지 않는다', () => {
  expect(cardImageSource('/photo.png', server, null).headers).toBeUndefined();
});
