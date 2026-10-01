import { decodeAuthJwt } from '../jwt-payload';

/**
 * RFC 4648 §5의 base64url 인코딩(패딩 제거 + URL-safe 치환).
 * 테스트용 가짜 JWT를 만들기 위해 사용. 실제 라이브러리는 jwt-decode가
 * 처리하지만, 테스트는 jwt-decode가 받아들일 수 있는 입력을 직접 만들어야
 * 한다 (signature 검증은 클라이언트가 하지 않으므로 임의 sig 문자열로 충분).
 */
function base64urlEncode(value: string): string {
  return Buffer.from(value, 'utf-8')
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function makeJwt(payload: Record<string, unknown>): string {
  const header = base64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64urlEncode(JSON.stringify(payload));
  // 클라이언트 jwtDecode는 sig를 검증하지 않으므로 placeholder.
  return `${header}.${body}.signature`;
}

describe('decodeAuthJwt', () => {
  it('정상 JWT는 email/name/picture를 그대로 추출한다', () => {
    const jwt = makeJwt({
      sub: 'user@example.com',
      email: 'user@example.com',
      name: '서소영',
      picture: 'https://lh3.googleusercontent.com/a/abc',
      exp: 9999999999,
    });
    expect(decodeAuthJwt(jwt)).toEqual({
      email: 'user@example.com',
      name: '서소영',
      picture: 'https://lh3.googleusercontent.com/a/abc',
    });
  });

  it('jwt가 null이면 null을 반환한다 (비로그인 graceful)', () => {
    expect(decodeAuthJwt(null)).toBeNull();
  });

  it('jwt가 빈 문자열이면 null을 반환한다', () => {
    expect(decodeAuthJwt('')).toBeNull();
  });

  it('jwt 형식이 깨졌으면 null을 반환한다 (graceful)', () => {
    expect(decodeAuthJwt('not-a-jwt')).toBeNull();
    expect(decodeAuthJwt('only.two')).toBeNull();
  });

  it('payload에 email이 없으면 null을 반환한다 (정상 프로필 아님)', () => {
    const jwt = makeJwt({ name: '소영', picture: 'https://...', exp: 1 });
    expect(decodeAuthJwt(jwt)).toBeNull();
  });

  it('email은 있고 name·picture가 누락되면 빈 문자열로 채운다', () => {
    const jwt = makeJwt({ email: 'a@b.com', exp: 1 });
    expect(decodeAuthJwt(jwt)).toEqual({
      email: 'a@b.com',
      name: '',
      picture: '',
    });
  });
});
