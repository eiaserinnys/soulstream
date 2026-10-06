/**
 * The App route lazy-imports PersistentSessionScreen itself. A same-origin frame
 * isolates its real active-session store and streams from the other review samples.
 * Review fixtures replace /api requests in the frame; no screen is duplicated here.
 */
export function PersistentSessionScreenReviewSample() {
  return <iframe title="영구 세션 전화면" className="persistent-session-review-frame" src="/persistent"/>;
}
