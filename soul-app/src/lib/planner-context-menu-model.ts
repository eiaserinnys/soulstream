export interface MenuCapability {
  enabled: boolean;
  reason?: string;
}

export interface PlannerContextMenuAction {
  key: string;
  label: string;
  onSelect(): void | Promise<void>;
  disabled?: boolean;
  disabledReason?: string;
  destructive?: boolean;
  separatorBefore?: boolean;
}

const ENABLED: MenuCapability = { enabled: true };

export function buildFolderContextMenuActions(input: {
  state: { starred: boolean; completed: boolean; inToday: boolean; system?: boolean };
  capability?: {
    moveToProject?: MenuCapability;
    complete?: MenuCapability;
    toggleToday?: MenuCapability;
  };
  actions: {
    open(): void | Promise<void>;
    copyId(): void | Promise<void>;
    toggleStar(): void | Promise<void>;
    moveToProject(): void | Promise<void>;
    complete(): void | Promise<void>;
    toggleToday(): void | Promise<void>;
  };
}): PlannerContextMenuAction[] {
  const complete = input.state.completed
    ? { enabled: false, reason: '이미 완료된 카드입니다.' }
    : input.capability?.complete ?? ENABLED;
  return [
    action('open', '카드 열기', input.actions.open),
    action('copy-id', '카드 페이지 ID 복사', input.actions.copyId),
    ...(!input.state.system ? [action('toggle-star', input.state.starred ? '별표 해제' : '별표 추가', input.actions.toggleStar, {
      separatorBefore: true,
    })] : []),
    action('move-project', '다른 프로젝트로 이동', input.actions.moveToProject, {
      capability: input.capability?.moveToProject,
    }),
    ...(!input.state.system ? [action('complete', '완료 처리', input.actions.complete, {
      capability: complete,
      destructive: true,
    })] : []),
    ...(!input.state.system ? [action(
      'toggle-today',
      input.state.inToday ? '오늘 플래너에서 제거' : '오늘 플래너에 추가',
      input.actions.toggleToday,
      { capability: input.capability?.toggleToday },
    )] : []),
  ];
}

export function buildProjectManagementMenuActions(input: {
  actions: {
    rename(): void | Promise<void>;
    archive(): void | Promise<void>;
  };
}): PlannerContextMenuAction[] {
  return [
    action('rename', '이름 변경', input.actions.rename),
    action('archive', '보관', input.actions.archive, { destructive: true }),
  ];
}

export function buildProjectContextMenuActions(input: {
  completed?: boolean;
  capability?: { createFolder?: MenuCapability };
  actions: {
    open(): void | Promise<void>;
    copyId(): void | Promise<void>;
    createFolder(): void | Promise<void>;
    setStatus?(): void | Promise<void>;
  };
}): PlannerContextMenuAction[] {
  return [
    action('open', '폴더 열기', input.actions.open),
    action('copy-id', '폴더 ID 복사', input.actions.copyId),
    action('create-task', '새 폴더', input.actions.createFolder, {
      separatorBefore: true,
      capability: input.capability?.createFolder,
    }),
    ...(input.actions.setStatus ? [action(
      'set-folder-status',
      input.completed ? '다시 열기' : '완료 처리',
      input.actions.setStatus,
    )] : []),
  ];
}

export function buildSessionContextMenuActions(input: {
  capability?: {
    continueSession?: MenuCapability;
    moveToFolder?: MenuCapability;
    resumeAfterLimit?: MenuCapability;
  };
  actions: {
    copyId(): void | Promise<void>;
    continueSession(): void | Promise<void>;
    resumeAfterLimit(): void | Promise<void>;
    rename(): void | Promise<void>;
    moveToFolder(): void | Promise<void>;
    delete(): void | Promise<void>;
  };
}): PlannerContextMenuAction[] {
  return [
    action('copy-id', '세션 ID 복사', input.actions.copyId),
    action('continue', '이 세션을 이어서 시작하기', input.actions.continueSession, {
      separatorBefore: true,
      capability: input.capability?.continueSession,
    }),
    action(
      'resume-after-limit',
      '리밋이 풀릴 때 재개',
      input.actions.resumeAfterLimit,
      { capability: input.capability?.resumeAfterLimit },
    ),
    action('rename', '이름 변경', input.actions.rename),
    action('move-task', '다른 폴더로 이동', input.actions.moveToFolder, {
      capability: input.capability?.moveToFolder,
    }),
    action('delete', '삭제', input.actions.delete, {
      destructive: true,
      separatorBefore: true,
    }),
  ];
}

function action(
  key: string,
  label: string,
  onSelect: () => void | Promise<void>,
  options: {
    capability?: MenuCapability;
    destructive?: boolean;
    separatorBefore?: boolean;
  } = {},
): PlannerContextMenuAction {
  const capability = options.capability ?? ENABLED;
  return {
    key,
    label,
    onSelect,
    ...(capability.enabled
      ? {}
      : { disabled: true, disabledReason: capability.reason ?? '현재 실행할 수 없습니다.' }),
    ...(options.destructive ? { destructive: true } : {}),
    ...(options.separatorBefore ? { separatorBefore: true } : {}),
  };
}
