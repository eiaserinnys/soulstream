export type PersistentSessionDevicePreferences = {
  openOnStart: boolean;
  lastSessionId: string | null;
  showWeeklyUsage: boolean;
  weeklyUsageNodeSelection: PersistentSessionWeeklyUsageNodeSelection | null;
};

export type PersistentSessionWeeklyUsageNodeSelection = {
  configuredNodeId: string;
  selectedNodeId: string | null;
};

type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

const defaults: PersistentSessionDevicePreferences = {
  openOnStart: false,
  lastSessionId: null,
  showWeeklyUsage: false,
  weeklyUsageNodeSelection: null,
};

export function persistentSessionDevicePreferenceKey(email: string): string {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) throw new Error("이메일이 있어야 기기별 영구 세션 설정을 저장할 수 있습니다.");
  return `soulstream-pas-device:${normalizedEmail}`;
}

export function readPersistentSessionDevicePreferences(
  email: string,
  storage: PreferenceStorage | undefined = localStorageForBrowser(),
): PersistentSessionDevicePreferences {
  if (!storage) return { ...defaults };
  const serialized = storage.getItem(persistentSessionDevicePreferenceKey(email));
  if (!serialized) return { ...defaults };
  try {
    const value = JSON.parse(serialized) as Partial<PersistentSessionDevicePreferences>;
    return {
      openOnStart: typeof value.openOnStart === "boolean" ? value.openOnStart : defaults.openOnStart,
      lastSessionId: typeof value.lastSessionId === "string" ? value.lastSessionId : defaults.lastSessionId,
      showWeeklyUsage: typeof value.showWeeklyUsage === "boolean" ? value.showWeeklyUsage : defaults.showWeeklyUsage,
      weeklyUsageNodeSelection: normalizeWeeklyUsageNodeSelection(value.weeklyUsageNodeSelection),
    };
  } catch {
    return { ...defaults };
  }
}

export function setPersistentSessionOpenOnStart(
  email: string,
  openOnStart: boolean,
  storage: PreferenceStorage | undefined = localStorageForBrowser(),
): PersistentSessionDevicePreferences {
  return write(email, { ...readPersistentSessionDevicePreferences(email, storage), openOnStart }, storage);
}

export function setPersistentSessionLastSessionId(
  email: string,
  lastSessionId: string | null,
  storage: PreferenceStorage | undefined = localStorageForBrowser(),
): PersistentSessionDevicePreferences {
  return write(email, { ...readPersistentSessionDevicePreferences(email, storage), lastSessionId }, storage);
}

export function setPersistentSessionShowWeeklyUsage(
  email: string,
  showWeeklyUsage: boolean,
  storage: PreferenceStorage | undefined = localStorageForBrowser(),
): PersistentSessionDevicePreferences {
  return write(email, { ...readPersistentSessionDevicePreferences(email, storage), showWeeklyUsage }, storage);
}

export function setPersistentSessionWeeklyUsageNodeSelection(
  email: string,
  weeklyUsageNodeSelection: PersistentSessionWeeklyUsageNodeSelection | null,
  storage: PreferenceStorage | undefined = localStorageForBrowser(),
): PersistentSessionDevicePreferences {
  return write(email, { ...readPersistentSessionDevicePreferences(email, storage), weeklyUsageNodeSelection }, storage);
}

function normalizeWeeklyUsageNodeSelection(value: unknown): PersistentSessionWeeklyUsageNodeSelection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const selection = value as Record<string, unknown>;
  if (typeof selection.configuredNodeId !== "string") return null;
  if (selection.selectedNodeId !== null && typeof selection.selectedNodeId !== "string") return null;
  return { configuredNodeId: selection.configuredNodeId, selectedNodeId: selection.selectedNodeId };
}

function write(
  email: string,
  preferences: PersistentSessionDevicePreferences,
  storage: PreferenceStorage | undefined,
): PersistentSessionDevicePreferences {
  storage?.setItem(persistentSessionDevicePreferenceKey(email), JSON.stringify(preferences));
  return preferences;
}

function localStorageForBrowser(): PreferenceStorage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}
