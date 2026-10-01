import { Alert } from 'react-native';
import type { Folder } from '../../api/types';
import { showAppContextMenu } from '../menus/AppContextMenu';
import { buildProjectManagementMenuActions, type PlannerContextMenuAction } from '../../lib/planner-context-menu-model';
import { confirmPlannerAction, promptPlannerText } from './plannerNativeUI';

interface ProjectManagementActions {
  renameFolder(folderId: string, name: string): Promise<unknown>;
  archiveFolder(folderId: string, version: number): Promise<unknown>;
}

export function showProjectManagement(
  folder: Folder,
  actions: ProjectManagementActions,
  options: { extraActions?: PlannerContextMenuAction[]; nameLabel?: string } = {},
) {
  const rename = () => promptText(`${options.nameLabel ?? '프로젝트'} 이름 변경`, '새 이름', (name) => {
    void actions.renameFolder(folder.id, name).catch(
      reportPlannerError('프로젝트 이름을 바꾸지 못했습니다.'),
    );
  }, folder.name);
  const archive = () => confirmPlannerAction({
    title: '폴더 보관',
    message: '폴더와 내용을 보존하고 목록에서 숨깁니다.',
    confirmText: '보관',
    destructive: true,
    onConfirm: () => {
      if (typeof folder.version !== 'number') {
        reportPlannerError('폴더를 보관하지 못했습니다.')(new Error('폴더 버전을 확인할 수 없습니다.'));
        return;
      }
      void actions.archiveFolder(folder.id, folder.version).catch(
        reportPlannerError('폴더를 보관하지 못했습니다.'),
      );
    },
  });
  const managementActions = buildProjectManagementMenuActions({
    actions: { rename, archive },
  });
  showAppContextMenu([
    managementActions[0]!,
    ...(options.extraActions ?? []),
    managementActions[1]!,
  ], folder.name);
}

export function promptText(
  title: string,
  message: string,
  onSubmit: (value: string) => void,
  current = '',
) {
  promptPlannerText({
    title,
    message,
    current,
    onSubmit: (value) => {
      if (value) onSubmit(value);
    },
  });
}

export function reportPlannerError(title: string) {
  return (error: unknown) => Alert.alert(
    title,
    error instanceof Error ? error.message : String(error),
  );
}
