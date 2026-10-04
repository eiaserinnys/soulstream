/** Redact credentials at the settings display/copy boundary, retaining useful JS traces. */
export function settingsDiagnosticText(text: string): string {
  return text
    .replace(/(Bearer\s+)[^\s,;]+/gi, '$1[숨김]')
    .replace(/((?:authorization|cookie|password|token|api[_-]?key|auth[_-]?code)\s*[:=]\s*)[^\s,;]+/gi, '$1[숨김]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[숨김]@')
    .replace(/([?&](?:key|token|code|secret|password)=)[^&#\s]+/gi, '$1[숨김]');
}
