import { createDialogueApi } from '../dialogue-fixtures';
import storage from '../fixture-async-storage';

it('keeps card, folder and session mutations in memory without fetching', async () => {
  const fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('network forbidden'));
  const api = createDialogueApi();
  const card = await api.createCard({ folderId: 'public-project', title: '메모리 카드', request: '예시', idempotencyKey: 'public-card-create' });
  expect((await api.getCard(card.card!.id)).card.title).toBe('메모리 카드');
  const folder = await api.createFolder({ name: '메모리 폴더', idempotencyKey: 'public-folder-create' });
  expect((await api.getCatalog()).folders.some(item => item.id === folder.folder.id)).toBe(true);
  const session = await api.createSession({ prompt: '메모리 세션', folderId: 'public-project' });
  expect((await api.getSessionsByIds([session.agentSessionId!]))[0].agentSessionId).toBe(session.agentSessionId);
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
});

it('isolates drafts and settings from browser/native persistent storage', async () => {
  await storage.setItem('settings', '공개 예시');
  expect(await storage.getItem('settings')).toBe('공개 예시');
  await storage.removeItem('settings');
  expect(await storage.getItem('settings')).toBeNull();
});
