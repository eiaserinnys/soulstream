// The component review never hydrates native credentials or saved server settings.
// State lives in Zustand only and is discarded on reload.
export const settingsStorage = {
  getItem: async (_name: string): Promise<string | null> => null,
  setItem: async (_name: string, _value: string): Promise<void> => {},
  removeItem: async (_name: string): Promise<void> => {},
};
