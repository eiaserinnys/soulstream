import { webViewContentLinks } from '../webview-content-links';

test('서버 링크만 앱에서 열고 초기 문서와 외부 주소는 기존 처리에 맡긴다', () => {
  const open = jest.fn();
  const props = webViewContentLinks('https://soulstream.test', open);
  expect(props.originWhitelist).toContain('https://soulstream.test');
  expect(props.onShouldStartLoadWithRequest({ url: 'about:blank' })).toBe(true);
  expect(props.onShouldStartLoadWithRequest({ url: 'https://soulstream.test/?card=one' })).toBe(false);
  expect(open).toHaveBeenCalledWith('https://soulstream.test/?card=one');
  expect(props.onShouldStartLoadWithRequest({ url: 'https://outside.test/' })).toBe(true);
});
