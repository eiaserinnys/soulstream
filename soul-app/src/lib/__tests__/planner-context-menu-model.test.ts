import {
  buildProjectContextMenuActions,
  buildProjectManagementMenuActions,
  buildSessionContextMenuActions,
  buildFolderContextMenuActions,
} from '../planner-context-menu-model';
import fs from 'node:fs';
import path from 'node:path';

const noop = jest.fn();

beforeEach(() => noop.mockClear());

test('폴더 메뉴에는 새 폴더와 완료 동작만 제공한다', () => {
  const menu = buildProjectContextMenuActions({
    actions: { open: noop, copyId: noop, createFolder: noop, setStatus: noop },
  });
  expect(menu.map((action) => action.label)).toEqual([
    '폴더 열기', '폴더 ID 복사', '새 폴더', '완료 처리',
  ]);
  expect(menu.map((action) => action.key)).not.toContain('toggle-checklist');
});

test('시스템 폴더에는 별표와 오늘 업무 메뉴를 표시하지 않는다', () => {
  const menu = buildFolderContextMenuActions({
    state: { starred: false, completed: false, inToday: false, system: true },
    actions: {
      open: noop, copyId: noop, toggleStar: noop, moveToProject: noop,
      complete: noop, toggleToday: noop,
    },
  });
  expect(menu.map((action) => action.key)).not.toContain('toggle-star');
  expect(menu.map((action) => action.key)).not.toContain('toggle-today');
});

test('업무 메뉴는 렌더 위치 없이 상태와 capability만으로 같은 배열을 만든다', () => {
  const input = {
    state: { starred: false, completed: false, inToday: true },
    capability: {
      moveToProject: { enabled: false, reason: '이동할 다른 프로젝트가 없습니다.' },
    },
    actions: {
      open: noop,
      copyId: noop,
      toggleStar: noop,
      moveToProject: noop,
      complete: noop,
      toggleToday: noop,
    },
  };

  const daily = buildFolderContextMenuActions(input);
  const project = buildFolderContextMenuActions(input);
  const feedAdapter = buildFolderContextMenuActions(input);
  const chatAdapter = buildFolderContextMenuActions(input);

  expect(project).toEqual(daily);
  expect(feedAdapter).toEqual(daily);
  expect(chatAdapter).toEqual(daily);
  expect(daily.map((action) => action.label)).toEqual([
    '카드 열기',
    '카드 페이지 ID 복사',
    '별표 추가',
    '다른 프로젝트로 이동',
    '완료 처리',
    '오늘 플래너에서 제거',
  ]);
  expect(daily[3]).toMatchObject({
    disabled: true,
    disabledReason: '이동할 다른 프로젝트가 없습니다.',
  });
  expect(daily[4].destructive).toBe(true);
});

test('프로젝트·세션 메뉴의 이름과 순서는 스펙 정본과 일치한다', () => {
  expect(buildProjectContextMenuActions({
    actions: { open: noop, copyId: noop, createFolder: noop, setStatus: noop },
  }).map((action) => action.label)).toEqual([
    '폴더 열기', '폴더 ID 복사', '새 폴더', '완료 처리',
  ]);

  expect(buildProjectManagementMenuActions({
    actions: { rename: noop, archive: noop },
  }).map((action) => action.label)).toEqual([
    '이름 변경', '보관',
  ]);

  expect(buildSessionContextMenuActions({
    capability: {
      continueSession: { enabled: true },
      moveToFolder: { enabled: false, reason: '이동할 다른 폴더가 없습니다.' },
      resumeAfterLimit: { enabled: false, reason: '아직 예약할 수 없습니다.' },
    },
    actions: {
      copyId: noop,
      continueSession: noop,
      resumeAfterLimit: noop,
      rename: noop,
      moveToFolder: noop,
      delete: noop,
    },
  }).map((action) => action.label)).toEqual([
    '세션 ID 복사',
    '이 세션을 이어서 시작하기',
    '리밋이 풀릴 때 재개',
    '이름 변경',
    '다른 폴더로 이동',
    '삭제',
  ]);
  expect(buildSessionContextMenuActions({
    capability: {
      continueSession: { enabled: true },
      moveToFolder: { enabled: true },
      resumeAfterLimit: { enabled: false, reason: '아직 예약할 수 없습니다.' },
    },
    actions: {
      copyId: noop,
      continueSession: noop,
      resumeAfterLimit: noop,
      rename: noop,
      moveToFolder: noop,
      delete: noop,
    },
  }).find((action) => action.key === 'resume-after-limit')).toMatchObject({
    label: '리밋이 풀릴 때 재개',
    disabled: true,
    disabledReason: '아직 예약할 수 없습니다.',
  });
});

test('세션 메뉴는 Feed·실행 이력·Chat 어댑터에서 capability가 같으면 완전히 같다', () => {
  const input = {
    capability: {
      continueSession: { enabled: true },
      moveToFolder: { enabled: false, reason: '이동할 다른 폴더가 없습니다.' },
    },
    actions: {
      copyId: noop,
      continueSession: noop,
      resumeAfterLimit: noop,
      rename: noop,
      moveToFolder: noop,
      delete: noop,
    },
  };
  const feed = buildSessionContextMenuActions(input);
  const history = buildSessionContextMenuActions(input);
  const chat = buildSessionContextMenuActions(input);
  expect(history).toEqual(feed);
  expect(chat).toEqual(feed);
});

test('완료 상태는 호출부가 complete capability를 활성화해도 다시 완료할 수 없다', () => {
  const menu = buildFolderContextMenuActions({
    state: { starred: false, completed: true, inToday: false },
    capability: { complete: { enabled: true } },
    actions: {
      open: noop, copyId: noop, toggleStar: noop, moveToProject: noop,
      complete: noop, toggleToday: noop,
    },
  });

  expect(menu.find((action) => action.key === 'complete')).toMatchObject({
    disabled: true,
    disabledReason: '이미 완료된 카드입니다.',
  });
});

test('오늘 플래너에 없는 업무는 웹과 같은 추가 라벨을 사용한다', () => {
  const menu = buildFolderContextMenuActions({
    state: { starred: false, completed: false, inToday: false },
    actions: {
      open: noop, copyId: noop, toggleStar: noop, moveToProject: noop,
      complete: noop, toggleToday: noop,
    },
  });

  expect(menu.find((action) => action.key === 'toggle-today')).toMatchObject({
    label: '오늘 플래너에 추가',
  });
});

test('화면 파일은 빌더 정본의 메뉴 라벨을 직접 선언하지 않는다', () => {
  const screensDir = path.resolve(__dirname, '../../screens');
  const source = fs.readdirSync(screensDir)
    .filter((file) => file.endsWith('.tsx'))
    .map((file) => fs.readFileSync(path.join(screensDir, file), 'utf8'))
    .join('\n');

  for (const label of [
    '오늘 플래너에 추가',
    '오늘 플래너에서 제거',
    '카드 페이지 ID 복사',
    '다른 프로젝트로 이동',
    '이 세션을 이어서 시작하기',
    '다른 폴더로 이동',
  ]) {
    expect(source).not.toContain(label);
  }
});
