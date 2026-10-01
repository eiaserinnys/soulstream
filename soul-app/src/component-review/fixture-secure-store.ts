// Native secure storage is unavailable in RN web. Review shells use memory only.
const values = new Map<string, string>();
export const getItemAsync = async (key: string) => values.get(key) ?? null;
export const setItemAsync = async (key: string, value: string) => { values.set(key, value); };
export const deleteItemAsync = async (key: string) => { values.delete(key); };
