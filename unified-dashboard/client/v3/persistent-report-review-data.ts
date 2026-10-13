import type { PersistentReportEntry } from '@seosoyoung/soul-ui';
export const reportReviewEntries: PersistentReportEntry[] = [
  { key: 'plan', kind: 'ask', title: '다음 구현 확인', card_numbers: [270], context: '확정한 설계대로 웹과 앱을 차례로 구현합니다.', action: '이 순서로 진행할까?', options: [], state: 'open', answer: '', updated_at: 'review' },
  { key: 'blog', kind: 'ask', title: '블로그 저장소 브랜치 정리', card_numbers: [328], context: 'seosoyoung-blog의 리모트 브랜치가 심각하다 하신 일입니다. 95개를 8개로 줄였습니다. 남은 로컬 브랜치 89개와 워크트리 52개는 git으로 직접 지워야 하고, 모두 머지된 것을 확인했습니다.', action: '"응" 하시면 지웁니다.', options: ['응'], state: 'open', answer: '', updated_at: 'review' },
  { key: 'digest', kind: 'see', title: '다이제스트 세 편', card_numbers: [338, 331, 333], context: '클리퍼로 넘기신 링크 셋이 글로 나왔습니다. 읽기만 하시면 됩니다.', action: '[Meta Muse Wonder](https://example.test/digest)', options: [], state: 'open', answer: '', updated_at: 'review' },
];
