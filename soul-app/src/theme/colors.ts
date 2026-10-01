export interface ColorScheme {
  // 배경 (낮 → 깊은 순)
  background: string;
  surface: string;
  surfaceMuted: string;
  surfaceCode: string;

  border: string;
  borderSubtle: string;

  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  textDisabled: string;
  textMuted: string;
  textPlaceholder: string;

  accent: string;
  accentTint: string;
  accentText: string;
  secondaryAction: string;
  secondaryActionText: string;
  intervention: string;
  interventionText: string;
  success: string;
  successText: string;
  error: string;
  danger: string;
  errorText: string;
  errorBg: string;
  warning: string;
  warningText: string;
  warningBg: string;
  agentBadge: string;

  link: string;
  codeText: string;

  statusRunning: string;
  statusIdle: string;
  statusCompleted: string;
  statusError: string;
}

export const DARK_COLORS: ColorScheme = {
  background: '#0f0f0f',
  surface: '#1c1c1e',
  surfaceMuted: '#181818',
  surfaceCode: '#0e0e10',

  border: '#2a2a2e',
  borderSubtle: '#1c1c1e',

  textPrimary: '#ffffff',
  textSecondary: '#d8d8de',
  textTertiary: '#d4d4db',
  textDisabled: '#a9a9b0',
  textMuted: '#d4d4db',
  textPlaceholder: '#8e8e93',

  accent: '#4A9EFF',
  accentTint: '#173552',
  accentText: '#07111f',
  secondaryAction: '#555555',
  secondaryActionText: '#ffffff',
  intervention: '#FF9500',
  interventionText: '#1f1300',
  success: '#4CAF50',
  successText: '#63D471',
  error: '#FF5252',
  danger: '#FF5252',
  errorText: '#FF6B6B',
  errorBg: '#2a1515',
  warning: '#ffb340',
  warningText: '#FFCA66',
  warningBg: '#3a2a15',
  agentBadge: '#c49aff',

  link: '#69b1ff',
  codeText: '#7DD3FC',

  statusRunning: '#4CAF50',
  statusIdle: '#888888',
  statusCompleted: '#4A9EFF',
  statusError: '#FF5252',
};

export const LIGHT_COLORS: ColorScheme = {
  background: '#ffffff',
  surface: '#f2f2f7',
  surfaceMuted: '#fafafc',
  surfaceCode: '#f0f0f3',

  border: '#d1d1d6',
  borderSubtle: '#e5e5ea',

  textPrimary: '#000000',
  textSecondary: '#2f3137',
  textTertiary: '#53575d',
  textDisabled: '#666b70',
  textMuted: '#53575d',
  textPlaceholder: '#666b70',

  accent: '#0a84ff',
  accentTint: '#d8ebff',
  accentText: '#07111f',
  secondaryAction: '#c7c7cc',
  secondaryActionText: '#07111f',
  intervention: '#ff9500',
  interventionText: '#1f1300',
  success: '#34c759',
  successText: '#237a3b',
  error: '#ff3b30',
  danger: '#ff3b30',
  errorText: '#c01e1e',
  errorBg: '#ffe5e5',
  warning: '#ff9f0a',
  warningText: '#8a4f00',
  warningBg: '#fff4e5',
  agentBadge: '#6e3bc1',

  link: '#0066cc',
  codeText: '#005bb5',

  statusRunning: '#34c759',
  statusIdle: '#8e8e93',
  statusCompleted: '#0a84ff',
  statusError: '#ff3b30',
};
