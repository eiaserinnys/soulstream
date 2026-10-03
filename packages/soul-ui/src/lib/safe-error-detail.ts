/** Only explicitly safe diagnostic fields cross the error-display boundary.
 * Error prose, headers, URLs and stack traces may contain credentials, even
 * when the details element is closed. Never return any unmatched source text.
 */
export function safeErrorDetail(raw: string): string {
  const status = raw.match(/\b(?:HTTP(?:\/\d(?:\.\d)?)?|status(?:Code)?)\s*[=:]?\s*([45]\d{2})\b/i)?.[1];
  const requestId = raw.match(/\brequest[_ -]?id["']?\s*[:=]\s*["']?([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\b/i)?.[1];
  return [
    status && `HTTP ${status}`,
    requestId && `요청 ID: ${requestId}`,
    "민감한 정보가 포함될 수 있어 오류 원문은 표시하지 않습니다.",
  ].filter(Boolean).join("\n");
}
