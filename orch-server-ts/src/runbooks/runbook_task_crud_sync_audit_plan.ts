export interface ActiveTaskProjectMountRow {
  runbookId: string;
  taskPageId: string;
  title: string;
  expectedFolderId: string;
  expectedProjectPageId: string;
  sourceProjectPageId: string | null;
  mountCount: number;
}

export interface ArchivedTaskMountRow {
  runbookId: string;
  taskPageId: string;
  title: string;
  sourcePageId: string;
  sourceKind: "project" | "daily" | "other";
  mountCount: number;
}

export interface TaskCrudSyncAuditPlan {
  activeTaskCount: number;
  activeProjectMountMissing: readonly ActiveTaskProjectMountFinding[];
  activeWrongProjectMount: readonly ActiveTaskProjectMountFinding[];
  activeDuplicateProjectMount: readonly ActiveTaskProjectMountFinding[];
  archivedMountResidue: readonly ArchivedTaskMountRow[];
}

export interface ActiveTaskProjectMountFinding {
  runbookId: string;
  taskPageId: string;
  title: string;
  expectedFolderId: string;
  expectedProjectPageId: string;
  actualProjectMounts: readonly {
    sourceProjectPageId: string;
    mountCount: number;
  }[];
}

export function planTaskCrudSyncAudit(input: {
  activeRows: readonly ActiveTaskProjectMountRow[];
  archivedRows: readonly ArchivedTaskMountRow[];
}): TaskCrudSyncAuditPlan {
  const tasks = groupActiveRows(input.activeRows);
  const findings = [...tasks.values()].map(toFinding);
  return {
    activeTaskCount: tasks.size,
    activeProjectMountMissing: findings.filter((finding) => (
      !finding.actualProjectMounts.some((mount) => (
        mount.sourceProjectPageId === finding.expectedProjectPageId
      ))
    )),
    activeWrongProjectMount: findings.filter((finding) => (
      finding.actualProjectMounts.some((mount) => (
        mount.sourceProjectPageId !== finding.expectedProjectPageId
      ))
    )),
    activeDuplicateProjectMount: findings.filter((finding) => (
      finding.actualProjectMounts.some((mount) => mount.mountCount > 1)
    )),
    archivedMountResidue: [...input.archivedRows].sort(compareArchived),
  };
}

function groupActiveRows(rows: readonly ActiveTaskProjectMountRow[]) {
  const grouped = new Map<string, {
    identity: Omit<ActiveTaskProjectMountFinding, "actualProjectMounts">;
    mounts: Map<string, number>;
  }>();
  for (const row of rows) {
    const entry = grouped.get(row.runbookId) ?? {
      identity: {
        runbookId: row.runbookId,
        taskPageId: row.taskPageId,
        title: row.title,
        expectedFolderId: row.expectedFolderId,
        expectedProjectPageId: row.expectedProjectPageId,
      },
      mounts: new Map<string, number>(),
    };
    if (row.sourceProjectPageId) {
      entry.mounts.set(row.sourceProjectPageId, row.mountCount);
    }
    grouped.set(row.runbookId, entry);
  }
  return grouped;
}

function toFinding(entry: ReturnType<typeof groupActiveRows> extends Map<string, infer T> ? T : never) {
  return {
    ...entry.identity,
    actualProjectMounts: [...entry.mounts.entries()]
      .map(([sourceProjectPageId, mountCount]) => ({ sourceProjectPageId, mountCount }))
      .sort((left, right) => left.sourceProjectPageId.localeCompare(right.sourceProjectPageId)),
  };
}

function compareArchived(left: ArchivedTaskMountRow, right: ArchivedTaskMountRow): number {
  return left.runbookId.localeCompare(right.runbookId)
    || left.sourcePageId.localeCompare(right.sourcePageId);
}
