import {
  PageMutationCore,
  type PageMutationActor,
  type PageMutationApplication,
} from "../page/page_mutation_core.js";
import { readPageYDocReplica } from "../page/page_yjs_model.js";
import type {
  TaskIdentityRepository,
  TaskMountBinding,
} from "./task_identity_contracts.js";
import {
  loadPageDocument,
  pageMutationIdempotencyKey,
} from "./task_identity_page.js";

export interface PlannedTaskMountApplication {
  pageId: string;
  application: PageMutationApplication;
}

export interface TaskMountReconciliationPlan {
  applications: readonly PlannedTaskMountApplication[];
  observedMounts: readonly TaskMountBinding[];
  scope: "all" | "project";
}

export async function planArchivedTaskMountRemoval(input: {
  repository: TaskIdentityRepository;
  mutationCore: PageMutationCore;
  taskPageId: string;
  actor: PageMutationActor;
  idempotencyKey: string;
}): Promise<TaskMountReconciliationPlan> {
  const mounts = await input.repository.listTaskMounts(input.taskPageId, "all");
  return {
    applications: await planDeletes(input, mounts.map((mount) => ({
      pageId: mount.sourcePageId,
      blockIds: mount.sourceBlockIds,
    }))),
    observedMounts: mounts,
    scope: "all",
  };
}

export async function planTaskProjectMountReconciliation(input: {
  repository: TaskIdentityRepository;
  mutationCore: PageMutationCore;
  createBlockId: () => string;
  taskPageId: string;
  taskTitle: string;
  targetProjectPageId: string;
  actor: PageMutationActor;
  idempotencyKey: string;
}): Promise<TaskMountReconciliationPlan> {
  const mounts = await input.repository.listTaskMounts(input.taskPageId, "project");
  const target = mounts.find((mount) => mount.sourcePageId === input.targetProjectPageId);
  const deletions = mounts.flatMap((mount) => {
    const keep = mount.sourcePageId === input.targetProjectPageId ? 1 : 0;
    const blockIds = mount.sourceBlockIds.slice(keep);
    return blockIds.length > 0 ? [{ pageId: mount.sourcePageId, blockIds }] : [];
  });
  const applications = [...await planDeletes(input, deletions)];
  if (!target?.sourceBlockIds.length) applications.push(await planCreateTargetMount(input));
  return {
    applications: applications.sort((left, right) => left.pageId < right.pageId ? -1 : left.pageId > right.pageId ? 1 : 0),
    observedMounts: mounts,
    scope: "project",
  };
}

async function planDeletes(
  input: {
    repository: TaskIdentityRepository;
    mutationCore: PageMutationCore;
    actor: PageMutationActor;
    idempotencyKey: string;
  },
  deletions: readonly { pageId: string; blockIds: readonly string[] }[],
): Promise<PlannedTaskMountApplication[]> {
  const grouped = groupDeletions(deletions);
  return await Promise.all([...grouped.entries()].sort(([left], [right]) => (
    left < right ? -1 : left > right ? 1 : 0
  )).map(async ([pageId, blockIds]) => {
    const document = await loadPageDocument(pageId, (id) => input.repository.readPageSnapshot(id));
    const replica = readPageYDocReplica(pageId, document);
    const existing = new Set(replica.blocks.map((block) => block.id));
    const missing = blockIds.filter((blockId) => !existing.has(blockId));
    if (missing.length > 0) {
      throw new Error(`task mount projection changed on ${pageId}: ${missing.join(",")}`);
    }
    return {
      pageId,
      application: input.mutationCore.mutate(document, {
        pageId,
        expectedVersion: replica.page.mutationVersion,
        command: {
          type: "batch_operations",
          operations: blockIds.map((blockId) => ({ op: "delete_block_subtree", blockId })),
        },
        actor: input.actor,
        idempotencyKey: pageMutationIdempotencyKey(
          "remove_task_mounts",
          input.actor,
          `${input.idempotencyKey}:${pageId}`,
        ),
        reason: "reconcile task identity mounts",
      }),
    };
  }));
}

async function planCreateTargetMount(input: {
  repository: TaskIdentityRepository;
  mutationCore: PageMutationCore;
  createBlockId: () => string;
  taskTitle: string;
  targetProjectPageId: string;
  actor: PageMutationActor;
  idempotencyKey: string;
}): Promise<PlannedTaskMountApplication> {
  const pageId = input.targetProjectPageId;
  const document = await loadPageDocument(pageId, (id) => input.repository.readPageSnapshot(id));
  const replica = readPageYDocReplica(pageId, document);
  return {
    pageId,
    application: input.mutationCore.mutate(document, {
      pageId,
      expectedVersion: replica.page.mutationVersion,
      command: {
        type: "create_block",
        id: input.createBlockId(),
        parentId: null,
        afterBlockId: replica.blocks.filter((block) => block.parentId === null).at(-1)?.id ?? null,
        blockType: "paragraph",
        text: `[[${input.taskTitle}]]`,
        properties: {},
      },
      actor: input.actor,
      idempotencyKey: pageMutationIdempotencyKey(
        "mount_task_identity_project",
        input.actor,
        `${input.idempotencyKey}:project:${pageId}`,
      ),
      reason: "mount moved task identity in project",
    }),
  };
}

function groupDeletions(
  deletions: readonly { pageId: string; blockIds: readonly string[] }[],
): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const deletion of deletions) {
    const current = grouped.get(deletion.pageId) ?? [];
    for (const blockId of deletion.blockIds) {
      if (!current.includes(blockId)) current.push(blockId);
    }
    grouped.set(deletion.pageId, current.sort());
  }
  return grouped;
}

export function mountBindingsEqual(
  left: readonly TaskMountBinding[],
  right: readonly TaskMountBinding[],
): boolean {
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function normalize(bindings: readonly TaskMountBinding[]) {
  return bindings.map((binding) => ({
    sourcePageId: binding.sourcePageId,
    sourceBlockIds: [...binding.sourceBlockIds].sort(),
  })).sort((left, right) => (
    left.sourcePageId < right.sourcePageId ? -1 : left.sourcePageId > right.sourcePageId ? 1 : 0
  ));
}
