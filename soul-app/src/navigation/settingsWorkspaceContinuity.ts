import type { SettingsCategory } from '../components/settings/settingsCategories';
import type { SettingsJobDestination, SettingsPersistentDestination } from '../components/settings/SettingsWorkspaceContext';

export const SETTINGS_WORKSPACE_CONTINUITY_KEY = JSON.stringify(['settings', 'workspace']);
export type SettingsWorkspaceContinuityState = {
  category: SettingsCategory | null;
  jobs: SettingsJobDestination;
  persistent: SettingsPersistentDestination;
};
