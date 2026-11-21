export type Appearance = "system" | "light" | "dark";

export interface UserPreferencesResponse<T> {
  email: string;
  preferences: T;
  hasBackground: boolean;
  backgroundUrl: string | null;
  updatedAt: string | null;
}

export function normalizeAppearance(value: unknown): Appearance {
  return value === "system" || value === "light" || value === "dark" ? value : "system";
}

export function normalizeUserPreferencesResponse<T>(
  value: unknown,
  normalizePreferences: (value: unknown) => T,
): UserPreferencesResponse<T> {
  const source = value && typeof value === "object" ? value as Partial<UserPreferencesResponse<unknown>> : {};
  return {
    email: typeof source.email === "string" ? source.email : "",
    preferences: normalizePreferences(source.preferences),
    hasBackground: Boolean(source.hasBackground),
    backgroundUrl: typeof source.backgroundUrl === "string" ? source.backgroundUrl : null,
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : null,
  };
}
