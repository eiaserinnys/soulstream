import { Alert, Platform } from 'react-native';
import { act, renderHook } from '@testing-library/react-native';
import { promptText, showProjectManagement } from '../projectManagement';
import { showAppContextMenu } from '../../menus/AppContextMenu';
import { usePlannerContextMenus } from '../../../hooks/usePlannerContextMenus';
import { useSessionStore } from '../../../store/sessionStore';

jest.mock('../../menus/AppContextMenu', () => ({ showAppContextMenu: jest.fn() }));
jest.mock('expo-crypto', () => ({ randomUUID: jest.fn(() => 'idempotency-key') }));

const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
const promptSpy = jest.spyOn(Alert, 'prompt').mockImplementation(jest.fn());

beforeEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
});

test('프로젝트 prompt는 명시적 취소·확인 버튼과 trim/blank 계약을 보존한다', () => {
  const submit = jest.fn();
  promptText('새 프로젝트', '프로젝트 이름', submit, '기존');

  const buttons = promptSpy.mock.calls[0][2] as any[];
  expect(buttons.map(({ text, style }) => ({ text, style }))).toEqual([
    { text: '취소', style: 'cancel' },
    { text: '확인', style: undefined },
  ]);
  buttons[1].onPress('  새 이름  ');
  buttons[1].onPress('   ');
  expect(submit).toHaveBeenCalledTimes(1);
  expect(submit).toHaveBeenCalledWith('새 이름');
});

test('폴더 관리 메뉴의 보관은 확인 뒤에만 실행한다', () => {
  const actions = { renameFolder: jest.fn(), archiveFolder: jest.fn().mockResolvedValue(undefined) };
  showProjectManagement({ id: 'project', name: '프로젝트', version: 3 } as never, actions);

  const menu = (showAppContextMenu as jest.Mock).mock.calls[0][0];
  menu.find((item: any) => item.key === 'archive').onSelect();
  const buttons = alertSpy.mock.calls[0][2] as any[];
  expect(buttons.map(({ text, style }) => ({ text, style }))).toEqual([
    { text: '취소', style: 'cancel' },
    { text: '보관', style: 'destructive' },
  ]);
  buttons[1].onPress();
  expect(actions.archiveFolder).toHaveBeenCalledWith('project', 3);
});

test('iOS 밖에서는 입력 불가 이유를 오류 없이 알린다', () => {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
  promptText('새 프로젝트', '프로젝트 이름', jest.fn());
  expect(alertSpy).toHaveBeenCalledWith('새 프로젝트', '텍스트 입력은 iOS 앱에서 지원합니다.');
});

test('하위 폴더 관리 메뉴는 이름 변경·이동·보관을 기존 메뉴에 모은다', async () => {
  const child = { id: 'child', name: '자료실', parentFolderId: 'parent', projectPageId: 'child-page', version: 3, sortOrder: 0 };
  useSessionStore.setState({ catalog: { folders: [
    { id: 'parent', name: '상위', projectPageId: 'parent-page', sortOrder: 0 },
    child,
    { id: 'target', name: '옮길 곳', projectPageId: 'target-page', sortOrder: 0 },
  ], sessions: {} } });
  const api = {
    updateFolder: jest.fn(async () => ({ folder: { ...child, parentFolderId: 'target', version: 4 } })),
  };
  const hook = renderHook(() => usePlannerContextMenus(api as never));
  act(() => hook.result.current.openChildFolderManagement(child));
  const menu = (showAppContextMenu as jest.Mock).mock.calls[0][0];
  expect(menu.map((item: { label: string }) => item.label)).toEqual([
    '이름 변경', '이동', '보관',
  ]);
  expect(menu.map((item: { key: string }) => item.key)).not.toContain('toggle-checklist');
  act(() => menu[1].onSelect());
  const targets = (showAppContextMenu as jest.Mock).mock.calls[1][0];
  await act(async () => { targets.find((item: { label: string }) => item.label === '옮길 곳').onSelect(); });
  expect(api.updateFolder).toHaveBeenCalledWith('child', expect.objectContaining({ parentFolderId: 'target', expectedVersion: 3 }));
});
