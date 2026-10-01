import { decideAutoSupplement } from '../autoSupplement';

describe('decideAutoSupplement', () => {
  it('첫 페이지 응답 전(historyCursor=undefined)에는 트리거하지 않는다', () => {
    expect(
      decideAutoSupplement({
        alreadySupplemented: false,
        historyCursor: undefined,
        reachedTop: false,
      }),
    ).toBeNull();
  });

  it('첫 페이지가 끝페이지(historyCursor=null)면 트리거하지 않는다 (에지 #7)', () => {
    // reachedTop=false로 격리 → null 가드만 검증
    expect(
      decideAutoSupplement({
        alreadySupplemented: false,
        historyCursor: null,
        reachedTop: false,
      }),
    ).toBeNull();
  });

  it('reachedTop이면 트리거하지 않는다 (파생 #3)', () => {
    expect(
      decideAutoSupplement({
        alreadySupplemented: false,
        historyCursor: 'abc',
        reachedTop: true,
      }),
    ).toBeNull();
  });

  it('이미 보충했으면 트리거하지 않는다 (1회 보장)', () => {
    expect(
      decideAutoSupplement({
        alreadySupplemented: true,
        historyCursor: 'abc',
        reachedTop: false,
      }),
    ).toBeNull();
  });

  it('첫 페이지 응답 후 cursor가 있고 reachedTop=false면 cursor 반환 (핵심 #1)', () => {
    expect(
      decideAutoSupplement({
        alreadySupplemented: false,
        historyCursor: 'abc',
        reachedTop: false,
      }),
    ).toBe('abc');
  });
});
