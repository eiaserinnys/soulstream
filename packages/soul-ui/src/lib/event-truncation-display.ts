import type { EventTruncation } from "../shared/sse-events";

const EVENT_TRUNCATION_SUFFIX = "\n[잘림]";

export function stripEventTruncationSuffix(
  content: string,
  truncation: EventTruncation | undefined,
): string {
  return truncation && content.endsWith(EVENT_TRUNCATION_SUFFIX)
    ? content.slice(0, -EVENT_TRUNCATION_SUFFIX.length)
    : content;
}
