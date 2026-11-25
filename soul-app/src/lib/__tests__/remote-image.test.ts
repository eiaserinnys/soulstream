import { remoteImageCachePolicy, resolveRemoteImageSource } from '../remote-image';

const SERVER = 'https://soul.test';

describe('remoteImageCachePolicy', () => {
  test.each([
    ['버전 초상', `${SERVER}/api/agent-portraits/seoyoung?v=abc123`, 'memory-disk'],
    ['버전 초상 상대 경로', '/api/agent-portraits/seoyoung?v=abc123', 'memory-disk'],
    ['첨부 content', `${SERVER}/api/attachments/att-1/content`, 'memory-disk'],
    ['첨부 content 맥락 질의', `${SERVER}/api/attachments/att-1/content?context_type=card&context_id=c1`, 'memory-disk'],
    ['v 있는 배경', `${SERVER}/api/user/background?v=1700000000`, 'memory-disk'],
    ['v 없는 중앙 초상', `${SERVER}/api/agent-portraits/seoyoung`, 'memory'],
    ['빈 v 중앙 초상', `${SERVER}/api/agent-portraits/seoyoung?v=`, 'memory'],
    ['옛 노드 초상', `${SERVER}/api/nodes/n1/agents/seoyoung/portrait`, 'memory'],
    ['옛 에이전트 초상', `${SERVER}/api/agents/seoyoung/portrait`, 'memory'],
    ['시스템 초상', `${SERVER}/api/system/portraits/system.png`, 'memory'],
    ['v 없는 배경', `${SERVER}/api/user/background`, 'memory'],
    ['첨부 files(바뀔 수 있는 옛 경로)', `${SERVER}/api/attachments/files?nodeId=n1&path=a.png`, 'memory'],
    ['구글 사진', 'https://lh3.googleusercontent.com/a/photo=s96-c', 'memory'],
    ['file 주소', 'file:///tmp/before.jpg', 'memory'],
  ])('%s → %s', (_name, uri, expected) => {
    expect(remoteImageCachePolicy(uri)).toBe(expected);
  });
});

describe('resolveRemoteImageSource', () => {
  test('같은 출처 절대 주소와 서버 상대 경로에만 Bearer를 붙인다', () => {
    expect(resolveRemoteImageSource(`${SERVER}/api/x.png`, SERVER, 'tok')).toEqual({
      uri: `${SERVER}/api/x.png`,
      headers: { Authorization: 'Bearer tok' },
    });
    expect(resolveRemoteImageSource('/api/x.png', `${SERVER}/`, 'tok')).toEqual({
      uri: `${SERVER}/api/x.png`,
      headers: { Authorization: 'Bearer tok' },
    });
  });

  test('바깥 출처와 토큰 없음에는 머리를 붙이지 않는다', () => {
    expect(resolveRemoteImageSource('https://lh3.googleusercontent.com/a.png', SERVER, 'tok')).toEqual({
      uri: 'https://lh3.googleusercontent.com/a.png',
    });
    expect(resolveRemoteImageSource(`${SERVER}/api/x.png`, SERVER, null)).toEqual({ uri: `${SERVER}/api/x.png` });
    expect(resolveRemoteImageSource(`${SERVER}.evil.test/api/x.png`, SERVER, 'tok')).toEqual({
      uri: `${SERVER}.evil.test/api/x.png`,
    });
  });
});
