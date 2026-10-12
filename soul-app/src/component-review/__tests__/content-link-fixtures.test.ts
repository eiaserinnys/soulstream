import {
  createContentLinkReviewApi,
  contentLinkDocumentId,
  contentLinkRelatedDocumentId,
  contentLinkReviewDocumentTitle,
} from '../fixture-client';

test('문서 검수 fixture는 읽힘·로딩·실패 상태를 제공한다', async () => {
  await expect(createContentLinkReviewApi('ready').getMarkdownDocument(contentLinkDocumentId))
    .resolves.toMatchObject({ id: contentLinkDocumentId, title: contentLinkReviewDocumentTitle, body: expect.stringContaining('# #270 계획 갱신 v4 (2026-10-12)') });
  await expect(createContentLinkReviewApi('ready').getMarkdownDocument(contentLinkRelatedDocumentId))
    .resolves.toMatchObject({ id: contentLinkRelatedDocumentId, title: '#270 누적 응답 뷰 검토 v3' });
  const loading = createContentLinkReviewApi('loading').getMarkdownDocument(contentLinkDocumentId);
  const loadingState = await Promise.race([loading.then(() => 'resolved'), Promise.resolve('pending')]);
  expect(loadingState).toBe('pending');
  await expect(createContentLinkReviewApi('error').getMarkdownDocument(contentLinkDocumentId))
    .rejects.toThrow('공개 예시: 문서를 불러오지 못했습니다.');
});

test('느린 문서 검수 fixture는 2.5초 뒤 문서를 돌려준다', async () => {
  jest.useFakeTimers();
  try {
    let settled = false;
    const request = createContentLinkReviewApi('slow').getMarkdownDocument(contentLinkDocumentId).then((document) => {
      settled = true;
      return document;
    });
    await jest.advanceTimersByTimeAsync(2499);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await expect(request).resolves.toMatchObject({ id: contentLinkDocumentId });
  } finally {
    jest.useRealTimers();
  }
});

test('카드의 공개 노트에는 같은 문서 화면을 여는 링크가 있다', async () => {
  await expect(createContentLinkReviewApi('ready').getCard('public-shell-card-owner'))
    .resolves.toMatchObject({
      notes: [expect.objectContaining({
        kind: 'note',
        body: expect.stringContaining('/api/markdown-documents/public-content-document'),
      })],
    });
});
