/** Redact credentials at the settings display/copy boundary, retaining useful JS traces. */
export function settingsDiagnosticText(text: string): string {
  return text
    .replace(/("(?:authorization|cookie|password|(?:access|refresh|auth)?[_-]?token|api[_-]?key|auth[_-]?code|secret)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[숨김]"')
    .replace(/(\bcookie\s*:\s*)[^\r\n]+/gi, '$1[숨김]')
    .replace(/(Bearer\s+)[^\s,;]+/gi, '$1[숨김]')
    .replace(/((?:authorization|cookie|password|token|api[_-]?key|auth[_-]?code)\s*[:=]\s*)[^\s,;]+/gi, '$1[숨김]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[숨김]@')
    .replace(/([?&](?:key|token|code|secret|password)=)[^&#\s]+/gi, '$1[숨김]');
}
