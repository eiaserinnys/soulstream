import type { ApiClient } from '../../api/client';
import { useUIStore } from '../../store/uiStore';
import { openPhoneSearchSession } from '../../navigation/phoneSessionNavigation';
import { openTabletSessionFromRoot } from '../../navigation/tabletSessionNavigation';
import {
  openPlannerFolderWorkspace,
  openPlannerSessionWorkspace,
  openStarredPageWorkspace,
} from '../planner-folder-workspace';
import { plannerFolderDetailToSummary } from '../../api/plannerTypes';
import { openContentLinkNavigation } from '../content-link-navigation';

jest.mock('../../navigation/phoneSessionNavigation', () => ({
  openPhoneSearchSession: jest.fn(),
}));
jest.mock('../../navigation/tabletSessionNavigation', () => ({
  openTabletSessionFromRoot: jest.fn(),
}));
jest.mock('../planner-folder-workspace', () => ({
  openPlannerFolderWorkspace: jest.fn(),
  openPlannerSessionWorkspace: jest.fn(),
  openStarredPageWorkspace: jest.fn(),
}));
jest.mock('../../api/plannerTypes', () => ({
  plannerFolderDetailToSummary: jest.fn(() => ({ folderId: 'folder-1' })),
}));

const document = { id: 'doc-1', title: '문서 제목', body: '# 본문', version: 4 };
const folderDetail = { folder: { id: 'folder-1' }, page: { id: 'page-1', title: '폴더 페이지' } };

function makeNavigation(topRoute = 'Main', params?: Record<string, unknown>) {
  const tabs = { navigate: jest.fn() };
  return {
    push: jest.fn(),
    getParent: jest.fn(() => tabs),
    getState: jest.fn(() => ({ index: 0, routes: [{ name: topRoute, params }] })),
    dispatch: jest.fn(),
    popTo: jest.fn(),
    tabs,
  };
}

function makeApi(overrides: Record<string, unknown> = {}) {
  return {
    getCard: jest.fn(),
    getPlannerFolder: jest.fn().mockResolvedValue(folderDetail),
    getPage: jest.fn().mockResolvedValue({ page: { id: 'page-1', title: '페이지 제목' } }),
    getMarkdownDocument: jest.fn().mockResolvedValue(document),
    getAttachmentMetadata: jest.fn().mockResolvedValue({
      descriptor: {
        attachment_id: 'asset-1', name: 'notes.txt', mime_type: 'text/plain', byte_size: 12,
        checksum_sha256: null, width: null, height: null, preview_kind: 'text', preview_mime_type: 'text/plain',
      },
      upload_status: 'committed',
    }),
    ...overrides,
  } as unknown as Pick<ApiClient, 'getCard' | 'getPlannerFolder' | 'getPage' | 'getMarkdownDocument' | 'getAttachmentMetadata' | 'readLegacyAttachmentText'>;
}

function deps(href: string, overrides: Record<string, unknown> = {}) {
  const navigation = makeNavigation();
  const api = makeApi();
  const openImage = jest.fn();
  const openAttachment = jest.fn();
  const resolvedAttachment = jest.fn();
  const openExternal = jest.fn();
  const alert = jest.fn();
  return {
    input: {
      href,
      serverUrl: 'https://soulstream.test',
      jwt: 'fixture-jwt',
      api,
      navigation,
      device: 'phone' as const,
      activeSessionId: 'active-session',
      leavePersistent: jest.fn(),
      openImage,
      openAttachment,
      openExternal,
      alert,
      ...overrides,
    },
    navigation,
    api,
    openImage,
    openAttachment,
    resolvedAttachment,
    openExternal,
    alert,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  useUIStore.setState({ activeSessionId: null });
});

test.each([
  'https://soulstream.test/api/markdown-documents/doc-1',
  'https://soulstream.test/?document=doc-1',
])('문서는 조회 전에 현재 stack의 MarkdownDocument 화면으로 연다 (%s)', async (href) => {
  const state = deps(href);

  await openContentLinkNavigation(state.input);
  if (state.openAttachment.mock.calls.length) {
    const [view] = state.openAttachment.mock.calls.at(-1)!;
    await view.loadMetadata().then(state.resolvedAttachment, () => {});
  }

  expect(state.api.getMarkdownDocument).not.toHaveBeenCalled();
  expect(state.navigation.push).toHaveBeenCalledWith('MarkdownDocument', { documentId: 'doc-1' });
  expect(state.alert).not.toHaveBeenCalled();
});

test('same-origin ID content links resolve metadata with URL context and open the attachment host', async () => {
  const context = { type: 'card' as const, id: 'card-1' };
  const state = deps('https://soulstream.test/api/attachments/asset-1/content?context_type=card&context_id=card-1');

  await openContentLinkNavigation(state.input);
  if (state.openAttachment.mock.calls.length) {
    const [view] = state.openAttachment.mock.calls.at(-1)!;
    await view.loadMetadata().then(state.resolvedAttachment, () => {});
  }

  expect(state.api.getAttachmentMetadata).toHaveBeenCalledWith('asset-1', context);
  expect(state.resolvedAttachment).toHaveBeenCalledWith(expect.objectContaining({
    key: 'asset-1', name: 'notes.txt', previewKind: 'text', readContext: context,
    source: {
      kind: 'ready', attachmentId: 'asset-1',
      previewUrl: '/api/attachments/asset-1/content?context_type=card&context_id=card-1',
      originalUrl: '/api/attachments/asset-1/content?context_type=card&context_id=card-1&download=true',
    },
  }));
  expect(state.openExternal).not.toHaveBeenCalled();
  expect(state.openImage).not.toHaveBeenCalled();
});

test('same-origin ID content links use the nearest attachment context when the URL has none', async () => {
  const context = { type: 'session' as const, id: 'session-7' };
  const state = deps('https://soulstream.test/api/attachments/asset-1/content', { readContext: context });

  await openContentLinkNavigation(state.input);
  if (state.openAttachment.mock.calls.length) {
    const [view] = state.openAttachment.mock.calls.at(-1)!;
    await view.loadMetadata().then(state.resolvedAttachment, () => {});
  }

  expect(state.api.getAttachmentMetadata).toHaveBeenCalledWith('asset-1', context);
  expect(state.resolvedAttachment).toHaveBeenCalledWith(expect.objectContaining({
    readContext: context,
    source: expect.objectContaining({
      previewUrl: '/api/attachments/asset-1/content?context_type=session&context_id=session-7',
    }),
  }));
  expect(state.openExternal).not.toHaveBeenCalled();
});

test('attachment content without URL or provider read context fails inside the app', async () => {
  const state = deps('https://soulstream.test/api/attachments/asset-1/content');

  await openContentLinkNavigation(state.input);
  if (state.openAttachment.mock.calls.length) {
    const [view] = state.openAttachment.mock.calls.at(-1)!;
    await view.loadMetadata().then(state.resolvedAttachment, () => {});
  }

  expect(state.api.getAttachmentMetadata).not.toHaveBeenCalled();
  expect(state.openAttachment).not.toHaveBeenCalled();
  expect(state.openExternal).not.toHaveBeenCalled();
  expect(state.alert).toHaveBeenCalledTimes(1);
});

test.each([403, 404, 503])('attachment metadata HTTP %i opens a lazy viewer and rejects its metadata task', async status => {
  const state = deps(
    'https://soulstream.test/api/attachments/asset-1/content?context_type=card&context_id=card-1',
    { api: makeApi({ getAttachmentMetadata: jest.fn().mockRejectedValue({ status }) }) },
  );

  await openContentLinkNavigation(state.input);
  if (state.openAttachment.mock.calls.length) {
    const [view] = state.openAttachment.mock.calls.at(-1)!;
    await view.loadMetadata().then(state.resolvedAttachment, () => {});
  }

  expect(state.openExternal).not.toHaveBeenCalled();
  expect(state.openAttachment).toHaveBeenCalledTimes(1);
  await expect(state.openAttachment.mock.calls[0][0].loadMetadata()).rejects.toEqual({ status });
  expect(state.alert).not.toHaveBeenCalled();
});

test('outside-origin attachment-like URL receives no internal metadata request', async () => {
  const state = deps('https://outside.test/api/attachments/asset-1/content?context_type=card&context_id=card-1');

  await openContentLinkNavigation(state.input);
  if (state.openAttachment.mock.calls.length) {
    const [view] = state.openAttachment.mock.calls.at(-1)!;
    await view.loadMetadata().then(state.resolvedAttachment, () => {});
  }

  expect(state.api.getAttachmentMetadata).not.toHaveBeenCalled();
  expect(state.openAttachment).not.toHaveBeenCalled();
  expect(state.openExternal).toHaveBeenCalledWith(state.input.href);
});

test('legacy same-origin image links use authenticated HEAD metadata and preserve their card context', async () => {
  const originalFetch = global.fetch;
  const fetchMock = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers({
      'content-type': 'image/png',
      'content-length': '42',
      'content-disposition': 'inline; filename="photo.png"',
    }),
  } as Response);
  global.fetch = fetchMock;
  const state = deps('/api/attachments/files?nodeId=node-1&path=%2Fincoming%2Fphoto.png&context_type=card&context_id=card-1');

  try {
    await openContentLinkNavigation(state.input);
  if (state.openAttachment.mock.calls.length) {
    const [view] = state.openAttachment.mock.calls.at(-1)!;
    await view.loadMetadata().then(state.resolvedAttachment, () => {});
  }
  } finally {
    global.fetch = originalFetch;
  }

  expect(fetchMock).toHaveBeenCalledWith(
    'https://soulstream.test/api/attachments/files?nodeId=node-1&path=%2Fincoming%2Fphoto.png&context_type=card&context_id=card-1',
    { method: 'HEAD', headers: { Authorization: 'Bearer fixture-jwt' } },
  );
  expect(state.resolvedAttachment).toHaveBeenCalledWith(expect.objectContaining({
    name: 'photo.png', mimeType: 'image/png', byteSize: null, previewKind: 'image',
    readContext: { type: 'card', id: 'card-1' },
  }));
  expect(state.openExternal).not.toHaveBeenCalled();
});

test.each([['svg', 'info'], ['heic', 'image']] as const)('legacy %s uses %s without a descriptor, with or without an alias', async (extension, previewKind) => {
  const originalFetch = global.fetch;
  const state = deps(`/api/attachments/files?nodeId=node-1&path=%2Fincoming%2Fphoto.${extension}&context_type=card&context_id=card-1`);
  try {
    for (const alias of [false, true]) {
      global.fetch = jest.fn().mockResolvedValue({ ok: true, headers: new Headers({
        'content-type': extension === 'svg' ? 'image/svg+xml' : 'image/heic',
        ...(alias ? { 'x-attachment-id': 'asset-1' } : {}),
      }) });
      await openContentLinkNavigation(state.input);
  if (state.openAttachment.mock.calls.length) {
    const [view] = state.openAttachment.mock.calls.at(-1)!;
    await view.loadMetadata().then(state.resolvedAttachment, () => {});
  }
      expect(state.resolvedAttachment).toHaveBeenLastCalledWith(expect.objectContaining({ previewKind }));
    }
  } finally { global.fetch = originalFetch; }
});

test('현재 맨 위와 같은 문서는 두 번 push하지 않는다', async () => {
  const navigation = makeNavigation('MarkdownDocument', { documentId: 'doc-1' });
  const state = deps('https://soulstream.test/?document=doc-1', { navigation });

  await openContentLinkNavigation(state.input);
  if (state.openAttachment.mock.calls.length) {
    const [view] = state.openAttachment.mock.calls.at(-1)!;
    await view.loadMetadata().then(state.resolvedAttachment, () => {});
  }

  expect(state.api.getMarkdownDocument).not.toHaveBeenCalled();
  expect(state.navigation.push).not.toHaveBeenCalled();
});

test('세션은 phone의 기존 검색 세션 opener에 숫자 eventId를 전달하고 미리 조회하지 않는다', async () => {
  const state = deps('https://soulstream.test/?session=session-1&event=42');

  await openContentLinkNavigation(state.input);
  if (state.openAttachment.mock.calls.length) {
    const [view] = state.openAttachment.mock.calls.at(-1)!;
    await view.loadMetadata().then(state.resolvedAttachment, () => {});
  }

  expect(openPhoneSearchSession).toHaveBeenCalledWith(state.navigation, 'session-1', 42);
  expect(state.api.getCard).not.toHaveBeenCalled();
  expect(state.api.getPlannerFolder).not.toHaveBeenCalled();
  expect(state.alert).not.toHaveBeenCalled();
});

test('태블릿 Main의 세션 링크는 기존 workspace opener에 eventId를 전달한다', async () => {
  const state = deps('https://soulstream.test/?session=session-2&event=58', {
    device: 'tabletLandscape',
  });

  await openContentLinkNavigation(state.input);
  if (state.openAttachment.mock.calls.length) {
    const [view] = state.openAttachment.mock.calls.at(-1)!;
    await view.loadMetadata().then(state.resolvedAttachment, () => {});
  }

  expect(openPlannerSessionWorkspace).toHaveBeenCalledWith('session-2', 58, undefined, 'nav');
  expect(openTabletSessionFromRoot).not.toHaveBeenCalled();
});

test('태블릿의 stack 화면에서 세션 링크는 기존 root opener를 쓴다', async () => {
  const state = deps('https://soulstream.test/?session=session-3', {
    device: 'tabletPortrait', navigation: makeNavigation('CardDetail'),
  });

  await openContentLinkNavigation(state.input);
  if (state.openAttachment.mock.calls.length) {
    const [view] = state.openAttachment.mock.calls.at(-1)!;
    await view.loadMetadata().then(state.resolvedAttachment, () => {});
  }

  expect(openTabletSessionFromRoot).toHaveBeenCalledTimes(1);
  const [navigation, leavePersistent, sessionId, eventId, storyOpenRequestId, source] =
    (openTabletSessionFromRoot as jest.Mock).mock.calls[0];
  expect(navigation).toBe(state.input.navigation);
  expect(leavePersistent).toBe(state.input.leavePersistent);
  expect([sessionId, eventId, storyOpenRequestId, source]).toEqual(['session-3', undefined, undefined, 'nav']);
  expect(openPlannerSessionWorkspace).not.toHaveBeenCalled();
});

test('카드는 phone에서 현재 stack에 push하고 태블릿 Main에서는 active session을 overlay에 전달한다', async () => {
  const phone = deps('https://soulstream.test/?card=card-1');
  await openContentLinkNavigation(phone.input);
  expect(phone.navigation.push).toHaveBeenCalledWith('CardDetail', { cardId: 'card-1' });
  expect(phone.api.getCard).not.toHaveBeenCalled();

  useUIStore.setState({ activeSessionId: 'tablet-session' });
  const openCardOverlay = jest.spyOn(useUIStore.getState(), 'openCardOverlay');
  const tablet = deps('https://soulstream.test/?card=card-2', {
    device: 'tabletLandscape', activeSessionId: useUIStore.getState().activeSessionId,
  });
  await openContentLinkNavigation(tablet.input);
  expect(openCardOverlay).toHaveBeenCalledWith('card-2', 'tablet-session');
  expect(tablet.navigation.push).not.toHaveBeenCalled();
});

test('현재 맨 위와 같은 카드는 두 번 push하지 않는다', async () => {
  const navigation = makeNavigation('CardDetail', { cardId: 'card-1' });
  const state = deps('https://soulstream.test/?card=card-1', { navigation });

  await openContentLinkNavigation(state.input);
  if (state.openAttachment.mock.calls.length) {
    const [view] = state.openAttachment.mock.calls.at(-1)!;
    await view.loadMetadata().then(state.resolvedAttachment, () => {});
  }

  expect(state.navigation.push).not.toHaveBeenCalled();
  expect(state.api.getCard).not.toHaveBeenCalled();
});

test('폴더는 includeCompleted=false로 읽고 phone의 FolderTab workspace를 연다', async () => {
  const state = deps('https://soulstream.test/?folder=folder-1');

  await openContentLinkNavigation(state.input);
  if (state.openAttachment.mock.calls.length) {
    const [view] = state.openAttachment.mock.calls.at(-1)!;
    await view.loadMetadata().then(state.resolvedAttachment, () => {});
  }

  expect(state.api.getPlannerFolder).toHaveBeenCalledWith('folder-1', { includeCompleted: false });
  expect(state.navigation.tabs.navigate).toHaveBeenCalledWith('FolderTab', {
    screen: 'FolderWorkspace',
    params: { folderPageId: 'page-1', folderTitle: '폴더 페이지', folderId: 'folder-1' },
  });
});

test('태블릿 Main의 폴더와 페이지 링크는 기존 overlay opener를 쓴다', async () => {
  const folder = deps('https://soulstream.test/?folder=folder-1', { device: 'tabletLandscape' });
  await openContentLinkNavigation(folder.input);
  expect(plannerFolderDetailToSummary).toHaveBeenCalledWith(folderDetail);
  expect(openPlannerFolderWorkspace).toHaveBeenCalledWith({ folderId: 'folder-1' }, 'nav');

  const page = deps('https://soulstream.test/?page=page-1', { device: 'tabletLandscape' });
  await openContentLinkNavigation(page.input);
  expect(page.api.getPage).toHaveBeenCalledWith('page-1');
  expect(openStarredPageWorkspace).toHaveBeenCalledWith('page-1', 'nav');
});

test.each([
  ['https://soulstream.test/api/attachments/files?nodeId=node-1&path=%2Ftmp%2Fphoto.png', true],
  ['https://soulstream.test/api/attachments/files?nodeId=node-1&path=%2Ftmp%2Ffile.pdf', false],
])('내부 첨부는 이미지 여부에 따라 기존 모달 또는 브라우저로 간다 (%s)', async (href, image) => {
  const state = deps(href);

  await openContentLinkNavigation(state.input);
  if (state.openAttachment.mock.calls.length) {
    const [view] = state.openAttachment.mock.calls.at(-1)!;
    await view.loadMetadata().then(state.resolvedAttachment, () => {});
  }

  if (image) {
    expect(state.openImage).toHaveBeenCalledWith({
      uri: 'https://soulstream.test/api/attachments/files?nodeId=node-1&path=%2Ftmp%2Fphoto.png',
      headers: { Authorization: 'Bearer fixture-jwt' },
    });
    expect(state.openExternal).not.toHaveBeenCalled();
  } else {
    expect(state.openExternal).toHaveBeenCalledWith(href);
    expect(state.openImage).not.toHaveBeenCalled();
  }
});

test.each([
  'https://outside.test/path',
  '/unknown/path',
])('분류되지 않은 주소는 절대 주소로 기존 브라우저를 연다 (%s)', async (href) => {
  const state = deps(href);

  await openContentLinkNavigation(state.input);
  if (state.openAttachment.mock.calls.length) {
    const [view] = state.openAttachment.mock.calls.at(-1)!;
    await view.loadMetadata().then(state.resolvedAttachment, () => {});
  }

  expect(state.openExternal).toHaveBeenCalledWith(new URL(href, 'https://soulstream.test').href);
  expect(state.navigation.push).not.toHaveBeenCalled();
});

test('내부 링크를 단독 렌더에서 열어도 browser를 호출하지 않는다', async () => {
  const state = deps('https://soulstream.test/?document=doc-1', { navigation: null });

  await openContentLinkNavigation(state.input);
  if (state.openAttachment.mock.calls.length) {
    const [view] = state.openAttachment.mock.calls.at(-1)!;
    await view.loadMetadata().then(state.resolvedAttachment, () => {});
  }

  expect(state.openExternal).not.toHaveBeenCalled();
  expect(state.alert).not.toHaveBeenCalled();
});


test('descriptor HEIC honors the server info preview kind', async () => {
  const state = deps('/api/attachments/asset-1/content?context_type=card&context_id=card-1');
  const response = await state.api.getAttachmentMetadata('asset-1', { type: 'card', id: 'card-1' });
  (state.api.getAttachmentMetadata as jest.Mock).mockResolvedValue({ ...response, descriptor: {
    ...response.descriptor, name: 'IMG_0001.heic', mime_type: 'image/heic', preview_kind: 'info',
  } });
  await openContentLinkNavigation(state.input);
  if (state.openAttachment.mock.calls.length) {
    const [view] = state.openAttachment.mock.calls.at(-1)!;
    await view.loadMetadata().then(state.resolvedAttachment, () => {});
  }
  expect(state.resolvedAttachment).toHaveBeenCalledWith(expect.objectContaining({ name: 'IMG_0001.heic', previewKind: 'info' }));
});

test.each(['proposal.html', 'proposal.htm'])('legacy %s 링크는 HEAD 전에 문서 힌트를 주고 원문 URL로 본문을 읽는다', async (filename) => {
  const originalFetch = global.fetch;
  const href = `/api/attachments/files?nodeId=node-1&path=%2Fincoming%2F${filename}&context_type=card&context_id=card-1`;
  global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, headers: new Headers({
    'content-type': 'text/html; charset=utf-8',
    'content-disposition': `inline; filename="${filename}"`,
  }) } as Response);
  const readLegacyAttachmentText = jest.fn().mockResolvedValue({ text: '<h1>문서 본문</h1>', truncated: false });
  const state = deps(href, { api: makeApi({ readLegacyAttachmentText }) });
  try {
    await openContentLinkNavigation(state.input);
    const [pending] = state.openAttachment.mock.calls.at(-1)!;
    // The document hint exists before the HEAD resolves so the preview opens wide.
    expect(pending.mimeType).toBe('text/html');
    expect(pending.previewKind).toBe('info');

    const resolved = await pending.loadMetadata();
    expect(resolved).toMatchObject({ name: filename, mimeType: 'text/html', previewKind: 'text' });
    const signal = new AbortController().signal;
    await expect(resolved.loadText(signal)).resolves.toEqual({ text: '<h1>문서 본문</h1>', truncated: false });
    expect(readLegacyAttachmentText).toHaveBeenCalledWith(`https://soulstream.test${href}`, signal);
    expect(state.api.getAttachmentMetadata).not.toHaveBeenCalled();
  } finally { global.fetch = originalFetch; }
});

test('legacy 평문 링크에는 문서 힌트를 붙이지 않는다', async () => {
  const originalFetch = global.fetch;
  const href = '/api/attachments/files?nodeId=node-1&path=%2Fincoming%2Fnotes.txt&context_type=card&context_id=card-1';
  global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, headers: new Headers({
    'content-type': 'text/plain', 'content-disposition': 'inline; filename="notes.txt"',
  }) } as Response);
  const state = deps(href);
  try {
    await openContentLinkNavigation(state.input);
    const [pending] = state.openAttachment.mock.calls.at(-1)!;
    expect(pending.mimeType).toBeNull();
    const resolved = await pending.loadMetadata();
    expect(resolved.previewKind).toBe('text');
  } finally { global.fetch = originalFetch; }
});

test('legacy 문서는 content-type이 octet-stream이어도 이름으로 문서를 판별해 loadText를 붙인다', async () => {
  const originalFetch = global.fetch;
  const href = '/api/attachments/files?nodeId=node-1&path=%2Fincoming%2Freports%2Fq3.html&context_type=card&context_id=card-1';
  global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, headers: new Headers({
    'content-type': 'application/octet-stream',
  }) } as Response);
  const readLegacyAttachmentText = jest.fn().mockResolvedValue({ text: '<p>분기 보고서</p>', truncated: true });
  const state = deps(href, { api: makeApi({ readLegacyAttachmentText }) });
  try {
    await openContentLinkNavigation(state.input);
    const [pending] = state.openAttachment.mock.calls.at(-1)!;
    expect(pending.mimeType).toBe('text/html');

    const resolved = await pending.loadMetadata();
    expect(resolved).toMatchObject({ name: 'q3.html', previewKind: 'text' });
    await expect(resolved.loadText(new AbortController().signal)).resolves.toEqual({ text: '<p>분기 보고서</p>', truncated: true });
  } finally { global.fetch = originalFetch; }
});
