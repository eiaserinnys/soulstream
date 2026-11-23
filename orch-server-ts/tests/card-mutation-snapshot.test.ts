import { expect, it, vi } from 'vitest';
import { CardRepositoryRead } from '../src/cards/control_plane/card_repository_read.js';
import { CardMutationCore } from '../src/cards/control_plane/card_mutation_core.js';
import { CardControlPlaneService } from '../src/cards/card_control_plane_service.js';
import { serializeCardMutation } from '../src/folders/folder_contracts.js';
import type {
  CardRow,
  FolderOperationRow,
  FolderRow,
  RepositorySql,
  SqlClient,
} from '../src/cards/control_plane/card_types.js';

const folderRow = (id: string, version = 1) => ({ id, version } as unknown as FolderRow);
const cardRow = (id: string, folderId: string) => ({ id, folder_id: folderId } as unknown as CardRow);
const operationRow = (overrides: Partial<FolderOperationRow> = {}) => ({
  id: 'op', folder_id: 'folder-a', target_kind: 'card', target_id: 'card-1', operation_type: 'update_card',
  actor_kind: 'agent', actor_session_id: 'actor', actor_event_id: 1, actor_user_id: null,
  idempotency_key: null, payload_json: {}, reason: null, created_at: new Date(0), ...overrides,
} as FolderOperationRow);

function fakeSql(route: (query: string) => unknown[]) {
  const queries: string[] = [];
  const sql: any = Object.assign(async (strings: TemplateStringsArray) => {
    const query = strings.join('');
    queries.push(query);
    return route(query);
  }, { json: (value: unknown) => value, begin: async (fn: (inner: unknown) => Promise<unknown>) => fn(sql) });
  return { sql: sql as SqlClient, queries };
}

/** Records the card IDs that reach the activity/attachment projection. */
class SpyRepository extends CardRepositoryRead {
  readonly projected: string[][] = [];
  override async projectCards(cards: readonly CardRow[]) {
    this.projected.push(cards.map(card => card.id));
    return cards.map(card => ({ ...card, latest_activity: null }));
  }
}

it('card mutation snapshot projects exactly the target card', async () => {
  const { sql } = fakeSql(query =>
    query.includes('FROM folders') ? [folderRow('folder-a')]
      : query.startsWith('SELECT * FROM cards WHERE id=') ? [cardRow('card-1', 'folder-a')]
        : (() => { throw new Error(`Unexpected SQL: ${query}`); })());
  const repo = new SpyRepository(sql);
  const snapshot = await repo.getMutationSnapshot('folder-a', 'card', 'card-1');
  expect(snapshot?.folder.id).toBe('folder-a');
  expect(snapshot?.card).toMatchObject({ id: 'card-1', latest_activity: null });
  expect(repo.projected).toEqual([['card-1']]);
});

it('folder mutation snapshot projects no cards at all', async () => {
  const { sql, queries } = fakeSql(query =>
    query.includes('FROM folders') ? [folderRow('folder-a')]
      : (() => { throw new Error(`Unexpected SQL: ${query}`); })());
  const repo = new SpyRepository(sql);
  expect(await repo.getMutationSnapshot('folder-a', 'folder', 'folder-a')).toEqual({
    folder: expect.objectContaining({ id: 'folder-a' }), card: null,
  });
  expect(repo.projected).toEqual([]);
  expect(queries).toHaveLength(1);
});

it('card mutation snapshot omits a target card that lives in another folder or is gone', async () => {
  const other = fakeSql(query =>
    query.includes('FROM folders') ? [folderRow('folder-a')]
      : query.startsWith('SELECT * FROM cards WHERE id=') ? [cardRow('card-1', 'folder-b')]
        : (() => { throw new Error(`Unexpected SQL: ${query}`); })());
  const otherRepo = new SpyRepository(other.sql);
  expect((await otherRepo.getMutationSnapshot('folder-a', 'card', 'card-1'))?.card).toBeNull();
  expect(otherRepo.projected).toEqual([]);

  const missing = fakeSql(query =>
    query.includes('FROM folders') ? [folderRow('folder-a')]
      : query.startsWith('SELECT * FROM cards WHERE id=') ? []
        : (() => { throw new Error(`Unexpected SQL: ${query}`); })());
  const missingRepo = new SpyRepository(missing.sql);
  expect((await missingRepo.getMutationSnapshot('folder-a', 'card', 'card-1'))?.card).toBeNull();
  expect(missingRepo.projected).toEqual([]);
});

it('card mutation snapshot is null when the folder itself is gone', async () => {
  const { sql } = fakeSql(query =>
    query.includes('FROM folders') ? []
      : (() => { throw new Error(`Unexpected SQL: ${query}`); })());
  const repo = new SpyRepository(sql);
  expect(await repo.getMutationSnapshot('folder-a', 'card', 'card-1')).toBeNull();
  expect(repo.projected).toEqual([]);
});

it('folder detail still projects every folder card while a mutation projects only the target', async () => {
  const cards = ['card-1', 'card-2', 'card-3'].map(id => cardRow(id, 'folder-a'));
  const { sql } = fakeSql(query =>
    query.includes('FROM folders') ? [folderRow('folder-a')]
      : query.includes('ORDER BY folder_id') ? cards
        : query.startsWith('SELECT * FROM cards WHERE id=') ? [cards[0]]
          : (() => { throw new Error(`Unexpected SQL: ${query}`); })());
  const repo = new SpyRepository(sql);
  expect((await repo.getSnapshot('folder-a'))?.cards).toHaveLength(3);
  expect((await repo.getMutationSnapshot('folder-a', 'card', 'card-1'))?.card).toMatchObject({ id: 'card-1' });
  expect(repo.projected).toEqual([['card-1', 'card-2', 'card-3'], ['card-1']]);
});

function coreHarness() {
  const getMutationSnapshot = vi.fn(async (folderId: string, targetKind: string, targetId: string) =>
    ({ folder: folderRow(folderId), card: targetKind === 'card' ? cardRow(targetId, folderId) : null }));
  const getSnapshot = vi.fn(async () => { throw new Error('full folder snapshot must not be read'); });
  const repo = {
    transaction: vi.fn(async (callback: (sql: RepositorySql) => Promise<unknown>) =>
      callback(fakeSql(() => []).sql as unknown as RepositorySql)),
    appendOperationTx: vi.fn(async (_sql: RepositorySql, params: any) => operationRow({
      folder_id: params.folderId, target_kind: params.targetKind, target_id: params.targetId,
      operation_type: params.operationType, payload_json: params.payload,
      idempotency_key: params.idempotencyKey ?? null, actor_event_id: params.actorEventId ?? null,
    })),
    getOperationByIdempotencyKey: vi.fn(async (): Promise<FolderOperationRow | null> => null),
    getFolderForUpdateTx: vi.fn(async () => folderRow('folder-a')),
    setFolderStatusTx: vi.fn(async () => folderRow('folder-a')),
    getMutationSnapshot,
    getSnapshot,
  };
  const emitFolderUpdated = vi.fn(async () => {});
  const emitCardUpdated = vi.fn(async () => {});
  const db = { appendEventTx: vi.fn(async () => 1) };
  const core = new CardMutationCore(db as any, repo as any, { emitFolderUpdated, emitCardUpdated });
  return { core, repo, getMutationSnapshot, getSnapshot, emitFolderUpdated, emitCardUpdated };
}

it('card-target mutation reads one target snapshot and emits one card update', async () => {
  const h = coreHarness();
  const result = await h.core.mutate({
    folderId: 'folder-a', targetKind: 'card', targetId: 'card-1', operationType: 'update_card',
    actor: { actorSessionId: 'actor' }, payload: { title: '수정' }, apply: async () => {},
  });
  expect(h.getMutationSnapshot.mock.calls).toEqual([['folder-a', 'card', 'card-1']]);
  expect(h.getSnapshot).not.toHaveBeenCalled();
  expect(h.emitCardUpdated.mock.calls).toEqual([['card-1', 'folder-a']]);
  expect(h.emitFolderUpdated).not.toHaveBeenCalled();
  expect(result.snapshot.card).toMatchObject({ id: 'card-1' });
  expect(result.idempotent).toBeUndefined();
});

it('folder-target mutation projects no cards and keeps the folder broadcast header flag', async () => {
  const h = coreHarness();
  await h.core.mutate({
    folderId: 'folder-a', targetKind: 'folder', targetId: 'folder-a', operationType: 'set_folder_status',
    actor: { actorSessionId: 'actor' }, payload: { status: 'open' }, apply: async () => {},
  });
  expect(h.getMutationSnapshot.mock.calls).toEqual([['folder-a', 'folder', 'folder-a']]);
  expect(h.emitFolderUpdated.mock.calls).toEqual([['folder-a', 'actor', true]]);
  expect(h.emitCardUpdated).not.toHaveBeenCalled();
});

it('sessionless mutation reads one target snapshot and broadcasts nothing', async () => {
  const h = coreHarness();
  const result = await h.core.mutateWithoutSession({
    folderId: 'folder-a', targetKind: 'card', targetId: 'card-1', operationType: 'note_card_assignee',
    actor: { actorKind: 'system', actorSessionId: null }, payload: {}, apply: async () => {},
  });
  expect(h.getMutationSnapshot.mock.calls).toEqual([['folder-a', 'card', 'card-1']]);
  expect(h.emitCardUpdated).not.toHaveBeenCalled();
  expect(h.emitFolderUpdated).not.toHaveBeenCalled();
  expect(result.snapshot.card).toMatchObject({ id: 'card-1' });
});

it('folder status settle reads the folder snapshot and broadcasts the folder once', async () => {
  const h = coreHarness();
  await h.core.setFolderStatus({ folderId: 'folder-a', expectedVersion: 1, status: 'completed', actorSessionId: 'actor' });
  expect(h.getMutationSnapshot.mock.calls).toEqual([['folder-a', 'folder', 'folder-a']]);
  expect(h.getSnapshot).not.toHaveBeenCalled();
  expect(h.emitFolderUpdated.mock.calls).toEqual([['folder-a', 'actor', true]]);
  expect(h.emitCardUpdated).not.toHaveBeenCalled();
});

it('idempotent move replay rebuilds the stored source-folder snapshot without rebroadcast', async () => {
  const h = coreHarness();
  h.repo.getOperationByIdempotencyKey.mockResolvedValueOnce(operationRow({
    folder_id: 'folder-a', target_kind: 'card', target_id: 'card-1', operation_type: 'move_card',
    payload_json: { folder_id: 'folder-b', after_card_id: null },
  }));
  const result = await h.core.mutate({
    folderId: 'folder-b', targetKind: 'card', targetId: 'card-1', operationType: 'move_card',
    actor: { actorSessionId: 'actor' }, payload: { folder_id: 'folder-b', after_card_id: null }, idempotencyKey: 'key',
    apply: async () => { throw new Error('idempotent replay must not apply'); },
  });
  expect(result.idempotent).toBe(true);
  expect(h.getMutationSnapshot.mock.calls).toEqual([['folder-a', 'card', 'card-1']]);
  expect(h.emitCardUpdated).not.toHaveBeenCalled();
  expect(h.emitFolderUpdated).not.toHaveBeenCalled();
});

it('idempotent create replay projects only the created card', async () => {
  const h = coreHarness();
  h.repo.getOperationByIdempotencyKey.mockResolvedValueOnce(operationRow({
    folder_id: 'folder-a', target_kind: 'card', target_id: 'new-card', operation_type: 'create_card',
    payload_json: { title: '새 카드' },
  }));
  await h.core.mutate({
    folderId: 'folder-a', targetKind: 'card', targetId: 'new-card', operationType: 'create_card',
    actor: { actorSessionId: 'actor' }, payload: { title: '새 카드' }, idempotencyKey: 'key',
    apply: async () => { throw new Error('idempotent replay must not apply'); },
  });
  expect(h.getMutationSnapshot.mock.calls).toEqual([['folder-a', 'card', 'new-card']]);
  expect(h.emitCardUpdated).not.toHaveBeenCalled();
});

function serviceHarness() {
  const repo = {
    getCard: vi.fn(async () => cardRow('card-1', 'folder-a')),
    getMutationSnapshot: vi.fn(async (folderId: string, targetKind: string, targetId: string) =>
      ({ folder: folderRow(folderId), card: targetKind === 'card' ? cardRow(targetId, folderId) : null })),
    getSnapshot: vi.fn(async () => { throw new Error('full folder snapshot must not be read'); }),
    getOperationByIdempotencyKey: vi.fn(async () => null),
  };
  const core = { mutate: vi.fn(), mutateTx: vi.fn() };
  const emitCardUpdated = vi.fn(async () => {});
  const emitFolderUpdated = vi.fn(async () => {});
  const service = Object.create(CardControlPlaneService.prototype) as CardControlPlaneService;
  Object.assign(service, {
    repo, core, broadcaster: { emitCardUpdated, emitFolderUpdated },
    repoSql: fakeSql(() => []).sql, warn: () => {},
  });
  return { service, repo, core, emitCardUpdated, emitFolderUpdated };
}

const moveParams = (folderId: string) =>
  ({ actorKind: 'agent' as const, actorSessionId: 'actor', cardId: 'card-1', folderId });
const settingsParams = (folderId: string) => ({
  actorKind: 'agent' as const, actorSessionId: 'actor', cardId: 'card-1', folderId,
  nodeId: null, agentId: null, modelPreset: null,
});
const sourceResult = (idempotent: boolean) => ({
  snapshot: { folder: folderRow('folder-a'), card: null },
  operation: operationRow({ folder_id: 'folder-a' }),
  eventId: 1, idempotent,
});

it('moveCard rebuilds the destination response from one card and emits the destination once', async () => {
  const h = serviceHarness();
  h.core.mutate.mockResolvedValueOnce(sourceResult(false));
  const result = await h.service.moveCard(moveParams('folder-b'));
  expect(h.repo.getMutationSnapshot.mock.calls).toEqual([['folder-b', 'card', 'card-1']]);
  expect(h.repo.getSnapshot).not.toHaveBeenCalled();
  expect(h.emitCardUpdated.mock.calls).toEqual([['card-1', 'folder-b']]);
  expect(result.snapshot).toMatchObject({ folder: { id: 'folder-b' }, card: { id: 'card-1' } });
  expect(result.idempotent).toBe(false);
});

it('moveCard into the same folder keeps the single source broadcast and returns that folder snapshot', async () => {
  const h = serviceHarness();
  h.core.mutate.mockResolvedValueOnce(sourceResult(false));
  await h.service.moveCard(moveParams('folder-a'));
  expect(h.emitCardUpdated).not.toHaveBeenCalled();
  expect(h.repo.getMutationSnapshot.mock.calls).toEqual([['folder-a', 'card', 'card-1']]);
});

it('idempotent move replay skips the destination broadcast but returns the destination snapshot', async () => {
  const h = serviceHarness();
  h.core.mutate.mockResolvedValueOnce(sourceResult(true));
  const result = await h.service.moveCard(moveParams('folder-b'));
  expect(h.emitCardUpdated).not.toHaveBeenCalled();
  expect(h.repo.getMutationSnapshot.mock.calls).toEqual([['folder-b', 'card', 'card-1']]);
  expect(result.idempotent).toBe(true);
  expect(result.snapshot).toMatchObject({ folder: { id: 'folder-b' }, card: { id: 'card-1' } });
});

it('settings save rebuilds the destination response from one card and keeps the destination broadcast condition', async () => {
  const h = serviceHarness();
  h.core.mutate.mockResolvedValueOnce(sourceResult(false));
  const result = await h.service.saveExecutionSettings(settingsParams('folder-b'));
  expect(h.repo.getMutationSnapshot.mock.calls).toEqual([['folder-b', 'card', 'card-1']]);
  expect(h.repo.getSnapshot).not.toHaveBeenCalled();
  expect(h.emitCardUpdated.mock.calls).toEqual([['card-1', 'folder-b']]);
  expect(result.snapshot).toMatchObject({ folder: { id: 'folder-b' }, card: { id: 'card-1' } });
});

it('settings save replay keeps the destination broadcast that today is not gated by idempotency', async () => {
  const h = serviceHarness();
  h.core.mutate.mockResolvedValueOnce(sourceResult(true));
  await h.service.saveExecutionSettings(settingsParams('folder-b'));
  expect(h.emitCardUpdated.mock.calls).toEqual([['card-1', 'folder-b']]);
});

it('settings save without a folder change does not broadcast and reads the same single card', async () => {
  const h = serviceHarness();
  h.core.mutate.mockResolvedValueOnce(sourceResult(false));
  await h.service.saveExecutionSettings(settingsParams('folder-a'));
  expect(h.emitCardUpdated).not.toHaveBeenCalled();
  expect(h.repo.getMutationSnapshot.mock.calls).toEqual([['folder-a', 'card', 'card-1']]);
});

it('maintenance post-processing reads one card snapshot instead of the folder', async () => {
  const h = serviceHarness();
  const onChange = vi.fn();
  Object.assign(h.service, { onMutation: onChange });
  await (h.service as any).afterCommitMaintenance([{
    result: { operation: operationRow({ folder_id: 'folder-a', operation_type: 'set_card_status' }), eventId: 5 },
    previousStatus: 'todo', previousAssigneeSessionId: null,
    committedCard: cardRow('card-1', 'folder-a'), cardChanged: true,
  }]);
  expect(h.repo.getMutationSnapshot.mock.calls).toEqual([['folder-a', 'card', 'card-1']]);
  expect(h.repo.getSnapshot).not.toHaveBeenCalled();
  expect(h.emitCardUpdated.mock.calls).toEqual([['card-1', 'folder-a']]);
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange.mock.calls[0]![0].result.snapshot.card).toMatchObject({ id: 'card-1' });
  expect(onChange.mock.calls[0]![0].result.eventId).toBe(5);
});

it('card mutation response keeps its JSON shape and nulls a card that left the folder', () => {
  const operation = operationRow();
  expect(serializeCardMutation({
    snapshot: { folder: folderRow('folder-b'), card: cardRow('card-1', 'folder-b') },
    operation, eventId: 1, idempotent: false,
  } as any)).toMatchObject({
    folderId: 'folder-b', card: { id: 'card-1', folderId: 'folder-b' },
    operation: { id: 'op', targetKind: 'card' }, idempotent: false,
  });
  expect(serializeCardMutation({
    snapshot: { folder: folderRow('folder-b'), card: null }, operation, eventId: 1, idempotent: false,
  } as any)).toMatchObject({ folderId: 'folder-b', card: null });
});

it('folder mutation response keeps serializing the folder without a card list', () => {
  const operation = operationRow({ target_kind: 'folder', target_id: 'folder-a' });
  expect(serializeCardMutation({
    snapshot: { folder: folderRow('folder-a'), card: null }, operation, eventId: 1, idempotent: true,
  } as any)).toEqual({
    folder: { id: 'folder-a', version: 1 },
    operation: expect.objectContaining({ id: 'op', targetKind: 'folder', targetId: 'folder-a' }),
    idempotent: true,
  });
});
