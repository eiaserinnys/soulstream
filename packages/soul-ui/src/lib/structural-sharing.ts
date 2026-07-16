import { replaceEqualDeep } from "@tanstack/react-query";

/**
 * Preserve every equal branch of a JSON-compatible response.
 *
 * TanStack Query already applies this at the query-data boundary. Consumers
 * must apply the same rule again after map/flatMap/DTO projection because
 * those transformations otherwise discard the retained identity.
 */
export function retainEqualValue<T>(previous: T | undefined, next: T): T {
  return replaceEqualDeep(previous, next);
}

/** Preserve Set identity when membership did not change. */
export function retainEqualSet<T>(
  previous: ReadonlySet<T>,
  next: ReadonlySet<T>,
): ReadonlySet<T> {
  if (previous.size === next.size) {
    let equal = true;
    for (const value of next) {
      if (!previous.has(value)) {
        equal = false;
        break;
      }
    }
    if (equal) return previous;
  }
  return next;
}
