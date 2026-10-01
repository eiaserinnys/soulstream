import { mergeServerDraft } from '../server-draft';

test('드래프트 편집 중 refetch에도 입력을 보존한다', () => {
  expect(mergeServerDraft('작성 중', '서버 이전값', '서버 새값')).toEqual({
    draft: '작성 중',
    server: '서버 이전값',
  });
});

test('수정하지 않은 드래프트는 새 서버 값과 동기화한다', () => {
  expect(mergeServerDraft('서버 이전값', '서버 이전값', '서버 새값')).toEqual({
    draft: '서버 새값',
    server: '서버 새값',
  });
});
