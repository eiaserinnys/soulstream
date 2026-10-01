import { buildSoulAppCallerInfo } from '../caller-info';

describe('buildSoulAppCallerInfo', () => {
  it('프로필이 있으면 source + 신원 4필드를 모두 채운다', () => {
    expect(
      buildSoulAppCallerInfo({
        email: 'a@b.com',
        name: '서소영',
        picture: 'https://lh3.googleusercontent.com/a/abc',
      }),
    ).toEqual({
      source: 'soul-app',
      display_name: '서소영',
      user_id: 'a@b.com', // 통합 스키마 v1: email = user_id (Google 진짜 sub 미보유)
      avatar_url: 'https://lh3.googleusercontent.com/a/abc',
      email: 'a@b.com',
    });
  });

  it('프로필이 null이면 source만 가진 minimal 형태를 반환한다 (push notifier 화이트리스트 호환)', () => {
    expect(buildSoulAppCallerInfo(null)).toEqual({ source: 'soul-app' });
  });

  it('name·picture가 빈 문자열이어도 신원 필드는 그대로 전달된다', () => {
    expect(
      buildSoulAppCallerInfo({
        email: 'a@b.com',
        name: '',
        picture: '',
      }),
    ).toEqual({
      source: 'soul-app',
      display_name: '',
      user_id: 'a@b.com',
      avatar_url: '',
      email: 'a@b.com',
    });
  });
});
