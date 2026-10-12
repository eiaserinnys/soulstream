import { createContentLinkReviewApi, contentLinkDocumentId } from '../fixture-client';

test('문서 검수 fixture는 읽힘·로딩·실패 상태를 제공한다', async () => {
  await expect(createContentLinkReviewApi('ready').getMarkdownDocument(contentLinkDocumentId))
    .resolves.toMatchObject({ id: contentLinkDocumentId, title: '공개 문서 예시', body: expect.any(String) });
  const loading = createContentLinkReviewApi('loading').getMarkdownDocument(contentLinkDocumentId);
  const loadingState = await Promise.race([loading.then(() => 'resolved'), Promise.resolve('pending')]);
  expect(loadingState).toBe('pending');
  await expect(createContentLinkReviewApi('error').getMarkdownDocument(contentLinkDocumentId))
    .rejects.toThrow('공개 예시: 문서를 불러오지 못했습니다.');
});
