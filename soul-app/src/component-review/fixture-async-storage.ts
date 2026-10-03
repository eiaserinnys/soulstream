// Review-only storage: Metro aliases the package before any store hydrates.
// No localStorage, native storage, or production settings are read or written.
const items = new Map<string, string>();
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
