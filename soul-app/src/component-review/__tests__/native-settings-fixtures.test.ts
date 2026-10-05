import { ApiHttpError } from '../../api/clientCore';
import { nativeSettingsReviewApi as api } from '../native-settings-fixtures';

// The fixture reads the review state from the URL, like the real review page does.
const setState = (state: string | null) => { (globalThis as any).window = Object.assign((globalThis as any).window ?? globalThis, { location: { search: state ? `?state=${state}` : '' } }); };
const model = (preset: string, effort: string | null) => ({ model_preset: preset, reasoning_effort: effort });
beforeEach(() => setState(null));

test('a single read answers for a released session and for a plain session left by a failed registration', async () => {
  await api.updatePersistentSession('review-pas-2', { enabled: false });
  expect((await api.getPersistentSession('review-pas-2')).session.persistent).toBe(false);
  expect((await api.listPersistentSessions()).sessions.map(item => item.session_id)).not.toContain('review-pas-2');
  await expect(api.updatePersistentSession('review-pas-2', { display_name: '이름', settings: { default_model: model('public-model', null) } })).rejects.toMatchObject({ status: 409 });

  setState('persistent-registration-error');
  let failure: ApiHttpError | undefined;
  try {
    await api.createPersistentSession({ display_name: '등록 실패', agent_id: 'public-agent', folder_id: 'public-project', initial_instruction: '', settings: { default_model: model('public-model', null) } });
  } catch (error) { failure = error as ApiHttpError; }
  const createdId = JSON.parse(failure!.body).created_session.session_id as string;
  setState(null);
  expect((await api.getPersistentSession(createdId)).session.persistent).toBe(false);
  expect((await api.listPersistentSessions()).sessions.map(item => item.session_id)).not.toContain(createdId);
  await api.updatePersistentSession(createdId, { display_name: '등록 실패', enabled: true, settings: { default_model: model('public-model', null) } });
  expect((await api.listPersistentSessions()).sessions.map(item => item.session_id)).toContain(createdId);
});

test('model_change and the pending target compare the preset and the effort together', async () => {
  const save = (effort: string | null) => api.updatePersistentSession('review-pas-1', { display_name: '관제', settings: { default_model: model('public-model', effort) } });
  const high = await save('high');
  expect(high.model_change).toBe('next_execution_start');
  expect(high.session.runtime.pending).toEqual({ target_model_preset: 'public-model', target_reasoning_effort: 'high' });
  expect((await save('high')).model_change).toBe('none');
  const backToRunning = await save(null);
  expect(backToRunning.model_change).toBe('none');
  expect(backToRunning.session.runtime.pending).toEqual({ target_model_preset: 'public-model', target_reasoning_effort: 'high' });
});

test('a create answer carries the folder and the reasoning effort that were sent', async () => {
  const { session } = await api.createPersistentSession({ display_name: '새 세션', agent_id: 'public-other-agent', folder_id: 'public-child', initial_instruction: '', settings: { default_model: model('public-model', 'high') } });
  expect(session.folder_id).toBe('public-child');
  expect(session.agent_id).toBe('public-other-agent');
  expect(session.settings.default_model).toEqual(model('public-model', 'high'));
  expect(session.runtime.current_model.reasoning_effort).toBe('high');
});
