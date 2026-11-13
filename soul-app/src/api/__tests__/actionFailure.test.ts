import { actionFailureMessage } from '../actionFailure';

describe('actionFailureMessage', () => {
  describe('멈춤', () => {
    it('409는 이미 끝난 세션일 수 있다고 알린다', () => {
      expect(actionFailureMessage('interrupt', { status: 409 }))
        .toBe('멈출 작업이 없습니다. 이미 끝난 세션일 수 있습니다.');
    });

    it('본문의 SESSION_NOT_RUNNING 코드도 409와 같은 문구를 고른다', () => {
      expect(actionFailureMessage('interrupt', {
        status: 400,
        body: JSON.stringify({ error: { code: 'SESSION_NOT_RUNNING' } }),
      })).toBe('멈출 작업이 없습니다. 이미 끝난 세션일 수 있습니다.');
    });

    it('404는 세션을 찾지 못했다고 알린다', () => {
      expect(actionFailureMessage('interrupt', { status: 404 }))
        .toBe('세션을 찾지 못해 멈추지 못했습니다.');
    });

    it.each([503, 504])('%s는 노드에 연결하지 못했다고 알린다', (status) => {
      expect(actionFailureMessage('interrupt', { status }))
        .toBe('노드에 연결하지 못해 멈추지 못했습니다. 다시 눌러 주세요.');
    });

    it('응답이 없는 네트워크 예외도 연결 실패로 알린다', () => {
      expect(actionFailureMessage('interrupt', {}))
        .toBe('노드에 연결하지 못해 멈추지 못했습니다. 다시 눌러 주세요.');
    });

    it('401은 로그인 만료로 알린다', () => {
      expect(actionFailureMessage('interrupt', { status: 401 }))
        .toBe('로그인이 만료되어 멈추지 못했습니다.');
    });

    it('그 밖의 상태는 일반 실패 문구를 쓴다', () => {
      expect(actionFailureMessage('interrupt', { status: 422 }))
        .toBe('멈추지 못했습니다. 다시 눌러 주세요.');
    });
  });

  describe('도구 승인·거절', () => {
    it.each([404, 409])('%s는 이미 끝난 요청이라고 알린다', (status) => {
      expect(actionFailureMessage('tool-approval', { status }))
        .toBe('이미 끝난 요청이라 보내지 못했습니다.');
    });

    it('본문의 해결 완료 코드도 같은 문구를 고른다', () => {
      expect(actionFailureMessage('tool-approval', {
        status: 400,
        body: JSON.stringify({ error: { code: 'APPROVAL_ALREADY_RESOLVED' } }),
      })).toBe('이미 끝난 요청이라 보내지 못했습니다.');
    });

    it('503과 응답 없는 예외는 연결 실패로 알린다', () => {
      expect(actionFailureMessage('tool-approval', { status: 503 }))
        .toBe('연결하지 못해 보내지 못했습니다. 다시 눌러 주세요.');
      expect(actionFailureMessage('tool-approval', {}))
        .toBe('연결하지 못해 보내지 못했습니다. 다시 눌러 주세요.');
    });

    it('그 밖의 상태는 일반 실패 문구를 쓴다', () => {
      expect(actionFailureMessage('tool-approval', { status: 500 }))
        .toBe('보내지 못했습니다. 다시 눌러 주세요.');
    });

    it('본문이 JSON이 아니어도 상태로 판정한다', () => {
      expect(actionFailureMessage('tool-approval', { status: 500, body: '<html>err</html>' }))
        .toBe('보내지 못했습니다. 다시 눌러 주세요.');
    });
  });
});
