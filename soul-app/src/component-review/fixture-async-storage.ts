// Review-only storage: Metro aliases the package before any store hydrates.
// No localStorage, native storage, or production settings are read or written.
const items = new Map<string, string>();
// A public failure record for the real diagnostics read/copy component.
if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('state') === 'diagnostic-record') {
  items.set('soul-app.session-succession-diagnostics.v1', JSON.stringify({ schemaVersion: 1, pending: [{
    schemaVersion: 1, diagnosticId: 'public-diagnostic', occurredAt: '2026-10-05T00:00:00Z', phase: 'render',
    folderId: 'public-folder', folderPageId: 'public-folder-page', projectPageId: 'public-project',
    screen: { visible: true, predecessorSessionId: 'public-session', folderBlockCount: 0, folderSessionCount: 0 },
    app: { version: 'public-review', buildNumber: null }, device: { platform: 'web', platformVersion: null, modelName: null, modelIdentifier: null, interfaceIdiom: null },
    error: { message: '공개 예시 오류 requestId=public-request', stack: '공개 예시 스택', componentStack: null },
  }] }));
}
const storage = {
  getItem: async (key: string) => items.get(key) ?? null,
  setItem: async (key: string, value: string) => { items.set(key, value); },
  removeItem: async (key: string) => { items.delete(key); },
  clear: async () => { items.clear(); },
  getAllKeys: async () => [...items.keys()],
  multiGet: async (keys: readonly string[]) => keys.map(key => [key, items.get(key) ?? null]),
  multiSet: async (entries: readonly (readonly [string, string])[]) => { entries.forEach(([key, value]) => items.set(key, value)); },
  multiRemove: async (keys: readonly string[]) => { keys.forEach(key => items.delete(key)); },
};
export default storage;
