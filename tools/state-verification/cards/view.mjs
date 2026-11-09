export const title = "카드 자동 실행: 중복 발사와 불확실한 수락";
export function state(v) {
  if(v.phase === 'admitted') return '배정됨';
  if(v.phase === 'running') return '착수 확인됨';
  if(v.phase === 'rejected') return '미수락 실행 종료';
  if(v.accepted) return v.expired ? '수락됨 · 착수 확인 지연' : '수락됨 · 착수 대기';
  return v.expired ? '수락 없이 기한 만료' : v.launches > 0 ? '발사됨 · 수락 확인 대기' : '발사권 획득';
}
export const step = (action) => ({
 ReadSnapshot:'실행할 카드 읽기', Claim:'발사권 획득', Send:'실행 요청 전송',
 Accept:'노드가 실행 수락', Expire:'기한 도달', Observe:'에이전트 착수 확인',
 RejectExpired:'수락되지 않은 실행 종료', Done:'완료'
}[action] ?? action);

