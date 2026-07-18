export interface TaskProjectMountInventoryRow {
  taskId: string;
  taskPageId: string;
  title: string;
  folderId: string;
  projectPageId: string;
  physicalMountCount: number;
  exactTitleBlockCount: number;
}

export interface TaskProjectMountBackfillPlan {
  create: readonly TaskProjectMountInventoryRow[];
  inspect: readonly TaskProjectMountInventoryRow[];
  alreadyMounted: readonly TaskProjectMountInventoryRow[];
  duplicate: readonly TaskProjectMountInventoryRow[];
}

export function planTaskProjectMountBackfill(
  rows: readonly TaskProjectMountInventoryRow[],
): TaskProjectMountBackfillPlan {
  const alreadyMounted = rows.filter((row) => row.physicalMountCount > 0);
  return {
    create: rows.filter((row) => (
      row.physicalMountCount === 0 && row.exactTitleBlockCount === 0
    )),
    inspect: rows.filter((row) => (
      row.physicalMountCount === 0 && row.exactTitleBlockCount > 0
    )),
    alreadyMounted,
    duplicate: alreadyMounted.filter((row) => row.physicalMountCount > 1),
  };
}
