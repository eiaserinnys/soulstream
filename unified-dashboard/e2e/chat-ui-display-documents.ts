const units = {
  pct: { dims: {}, symbol: '%', scale: 1 },
  gib: { dims: { bytes: 1 }, symbol: 'GiB', scale: 1 },
  slot: { dims: {}, symbol: '개', scale: 1 },
};
const kst = (minute: number) => {
  const h = 13 + Math.floor((5 + minute) / 60);
  const m = (5 + minute) % 60;
  return `2026-11-28T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+09:00`;
};

export const displayDocuments = {
  qResources: { schema_version: 1, units, body: [
    { id: 'q_intro1', kind: 'text', parts: ['메모리가 빠듯합니다. 무거운 검증은 하나 더 돌릴 수 있습니다.'] },
    { id: 'q_stats', kind: 'stats', tiles: [
      { label: 'CPU', value: 38, unit: 'pct', note: '8코어' },
      { label: '메모리', value: 12.6, unit: 'gib', note: '16 GiB 중', tone: 'warn' },
      { label: '디스크 여유', value: 41, unit: 'gib', note: '기준 30 GiB', tone: 'good' },
      { label: '검증 슬롯', value: '2 / 3', note: '대기 0' },
    ] },
    { id: 'q_line', kind: 'line', label: '지난 1시간', unit: 'pct', baseline: { value: 80, label: '기준' }, series: [
      { label: 'CPU', points: Array.from({ length: 13 }, (_, i) => ({ x: kst(i * 5), y: [22, 24, 27, 26, 30, 41, 38, 35, 33, 37, 34, 32, 38][i] })) },
      { label: '메모리', points: Array.from({ length: 13 }, (_, i) => ({ x: kst(i * 5), y: [61, 62, 63, 64, 65, 67, 68, 69, 71, 73, 76, 78, 79][i] })) },
    ] },
    { id: 'q_bars', kind: 'bars', label: '노드별 CPU와 메모리', unit: 'pct', series: [{ key: 'cpu', label: 'CPU' }, { key: 'mem', label: '메모리' }], items: [
      { label: 'eiaserinnys', value: [38, 79] },
      { label: 'eias-linegames-wsl', value: [22, 41] },
      { label: 'silent-manari-ts', value: [12, 35], excluded: true },
    ] },
  ] },
  qDiagrams: { schema_version: 1, body: [
    { id: 'q_intro2', kind: 'text', parts: ['따로 두지 않고 채팅 목록 부품으로 그립니다.'] },
    { id: 'q_compare3', kind: 'compare', columns: [
      { id: 'now', title: '지금', items: [{ text: '별도 도구로 화면을 연다' }, { text: '30초마다 다시 읽는다' }, { text: '카드만 그린다' }] },
      { id: 'next', title: '바꾼 뒤', selected: true, items: [{ mark: 'yes', text: '목록 부품에 카드를 묶는다' }, { mark: 'yes', text: '보는 사람 권한으로 읽는다' }, { mark: 'partial', text: '바뀐 행만 다시 그린다' }] },
      { id: 'drop', title: '걷어낼 것', items: [{ mark: 'no', text: '라이브 카드 보기 도구' }] },
    ] },
    { id: 'q_flow', kind: 'flow', nodes: [
      { id: 'agent', title: '에이전트', note: '구조와 묶음을 한 번 낸다', col: 1, row: 1, tone: 'warn' },
      { id: 'chat', title: '채팅 기록', note: '구조는 고치지 않는다', col: 2, row: 1, tone: 'good' },
      { id: 'view', title: '보는 사람 화면', note: '묶인 칸만 다시 그린다', col: 3, row: 1, tone: 'info' },
      { id: 'signal', title: 'card_updated', note: '바뀌었다는 신호', col: 2, row: 2, tone: 'good' },
      { id: 'read', title: '카드 조회', note: '보는 사람 권한으로', col: 3, row: 2, tone: 'good' },
    ], edges: [{ from: 'agent', to: 'chat' }, { from: 'chat', to: 'view' }, { from: 'view', to: 'read', both: true }, { from: 'signal', to: 'read' }] },
    { id: 'q_flow_two', kind: 'flow', nodes: [
      { id: 'ask', title: '요청', col: 1, row: 1 },
      { id: 'work', title: '처리', col: 2, row: 1 },
      { id: 'done', title: '결과', col: 2, row: 2 },
    ], edges: [{ from: 'ask', to: 'work' }, { from: 'work', to: 'done' }] },
    { id: 'q_badge', kind: 'badge', label: '검수 대기', tone: 'warn' },
  ] },
  qLists: { schema_version: 1, body: [
    { id: 'q_intro3', kind: 'text', parts: ['#2412 반영 중입니다. 세 노드 가운데 하나가 남았습니다.'] },
    { id: 'q_list', kind: 'list', numbered: true, label: '소울스트림', items: [
      { id: 'a', title: '#1961 소울스트림과 atom 영어, 일본어, 중국어 지원', note: '로젤린 silent-manari-ts 12분 전', badge: { label: '질문', tone: 'warn' }, value: '2/6', url: 'https://example.com/card/1961' },
      { id: 'b', title: '#1963 카드 기록 파편화 구조 해결 토론', note: '서소영 eiaserinnys 40분 전', badge: { label: '검수 대기', tone: 'warn' }, value: '4/4', url: 'https://example.com/card/1963' },
      { id: 'c', url: 'https://example.com/card/1964', title: '#1964 채팅 답변 동적 UI 조립과 라이브 카드 보기 통합', note: '서소영 eiaserinnys 방금', badge: { label: '실행 중', tone: 'good' }, value: '3/8' },
    ] },
    { id: 'q_steps', kind: 'steps', items: [
      { title: '머지', state: 'done', note: 'MCP 응답을 판단 칸만 담게 줄인다', time: '13:51' },
      { title: '빌드', state: 'done', note: '6분 12초', time: '13:52' },
      { title: '노드 반영', state: 'failed', note: 'silent-manari-ts 연결 끊김', time: '14:02' },
      { title: '동작 확인', state: 'pending', note: '세 노드 health와 채팅 화면' },
    ] },
    { id: 'q_table', kind: 'table', label: '구현 비교', columns: [
      { key: 'name', label: '구현' }, { key: 'how', label: '방식', wrap: true }, { key: 'data', label: '데이터만 갱신', type: 'badge' }, { key: 'link', label: '근거', type: 'link' },
    ], rows: [
      { name: 'A2UI', how: '선언형 부품 목록을 보내고 데이터는 따로 갱신한다', data: { label: '있음', tone: 'good' }, link: { label: 'A2UI 메시지 개념', url: 'https://example.com/a2ui' } },
      { name: 'json-render', how: 'JSON 요소 트리', data: { label: '있음', tone: 'good' }, link: null },
      { name: 'MCP Apps', how: '격리 HTML', data: { label: '없음', tone: 'bad' }, link: { label: 'MCP Apps 명세', url: 'https://example.com/mcp' } },
    ] },
  ] },
};

export const displayMediaDocument = {
  schema_version: 1,
  body: [
    { id: 'intro', kind: 'text', parts: ['그림과 작은 보고를 함께 보여줄게.'] },
    { id: 'landscape', kind: 'image', attachment_id: 'landscape', alt: '가로 그림', caption: '가로 그림 설명' },
    { id: 'portrait', kind: 'image', attachment_id: 'portrait', alt: '세로 그림', caption: '세로 그림 설명' },
    { id: 'html', kind: 'html', height: 120, alt: '노드별 사용량 보고', html: '<p style="color:var(--host-accent)">작은 정적 보고</p>' },
  ],
};
