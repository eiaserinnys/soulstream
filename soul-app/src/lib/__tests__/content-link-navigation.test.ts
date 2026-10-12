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

function makeNavigation(topRoute = 'Main') {
  const tabs = { navigate: jest.fn() };
  return {
    push: jest.fn(),
    getParent: jest.fn(() => tabs),
    getState: jest.fn(() => ({ index: 0, routes: [{ name: topRoute }] })),
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
    ...overrides,
  } as unknown as Pick<ApiClient, 'getCard' | 'getPlannerFolder' | 'getPage' | 'getMarkdownDocument'>;
}

function deps(href: string, overrides: Record<string, unknown> = {}) {
  const navigation = makeNavigation();
  const api = makeApi();
  const openImage = jest.fn();
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
      openExternal,
      alert,
      ...overrides,
    },
    navigation,
    api,
    openImage,
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
])('문서는 조회한 뒤 현재 stack의 MarkdownDocument 화면으로 연다 (%s)', async (href) => {
  const state = deps(href);

  await openContentLinkNavigation(state.input);

  expect(state.api.getMarkdownDocument).toHaveBeenCalledWith('doc-1');
  expect(state.navigation.push).toHaveBeenCalledWith('MarkdownDocument', {
    documentId: 'doc-1', initialDocument: document,
  });
  expect(state.alert).not.toHaveBeenCalled();
});

test('세션은 phone의 기존 검색 세션 opener에 숫자 eventId를 전달하고 미리 조회하지 않는다', async () => {
  const state = deps('https://soulstream.test/?session=session-1&event=42');

  await openContentLinkNavigation(state.input);

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

  expect(openPlannerSessionWorkspace).toHaveBeenCalledWith('session-2', 58, undefined, 'nav');
  expect(openTabletSessionFromRoot).not.toHaveBeenCalled();
});

test('태블릿의 stack 화면에서 세션 링크는 기존 root opener를 쓴다', async () => {
  const state = deps('https://soulstream.test/?session=session-3', {
    device: 'tabletPortrait', navigation: makeNavigation('CardDetail'),
  });

  await openContentLinkNavigation(state.input);

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

test('폴더는 includeCompleted=false로 읽고 phone의 FolderTab workspace를 연다', async () => {
  const state = deps('https://soulstream.test/?folder=folder-1');

  await openContentLinkNavigation(state.input);

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

test.each([404, 403])('문서 조회 HTTP %s 실패는 화면을 바꾸지 않고 한 줄 알림을 보낸다', async (status) => {
  const error = Object.assign(new Error('request failed'), { status });
  const state = deps('https://soulstream.test/?document=missing', {
    api: makeApi({ getMarkdownDocument: jest.fn().mockRejectedValue(error) }),
  });

  await openContentLinkNavigation(state.input);

  expect(state.navigation.push).not.toHaveBeenCalled();
  expect(state.alert).toHaveBeenCalledWith('문서를 열지 못했습니다.');
});

test('401은 기존 인증 만료 흐름에 맡기고 콘텐츠 알림을 추가하지 않는다', async () => {
  const error = Object.assign(new Error('unauthorized'), { status: 401 });
  const state = deps('https://soulstream.test/?document=missing', {
    api: makeApi({ getMarkdownDocument: jest.fn().mockRejectedValue(error) }),
  });

  await openContentLinkNavigation(state.input);

  expect(state.alert).not.toHaveBeenCalled();
  expect(state.navigation.push).not.toHaveBeenCalled();
});

test.each([
  'https://outside.test/path',
  '/unknown/path',
])('분류되지 않은 주소는 절대 주소로 기존 브라우저를 연다 (%s)', async (href) => {
  const state = deps(href);

  await openContentLinkNavigation(state.input);

  expect(state.openExternal).toHaveBeenCalledWith(new URL(href, 'https://soulstream.test').href);
  expect(state.navigation.push).not.toHaveBeenCalled();
});

test('내부 링크를 단독 렌더에서 열어도 browser를 호출하지 않고 한 줄 알린다', async () => {
  const state = deps('https://soulstream.test/?document=doc-1', { navigation: null });

  await openContentLinkNavigation(state.input);

  expect(state.openExternal).not.toHaveBeenCalled();
  expect(state.alert).toHaveBeenCalledWith('문서를 열지 못했습니다.');
});
