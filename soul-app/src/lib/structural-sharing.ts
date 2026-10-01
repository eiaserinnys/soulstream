export function replaceEqualDeep<T>(previous: T, incoming: T): T {
  if (Object.is(previous, incoming)) return previous;
  if (Array.isArray(previous) && Array.isArray(incoming)) {
    let equal = previous.length === incoming.length;
    const shared = incoming.map((value, index) => {
      const next = replaceEqualDeep(previous[index], value);
      if (!Object.is(next, previous[index])) equal = false;
      return next;
    });
    return (equal ? previous : shared) as T;
  }
  if (isRecord(previous) && isRecord(incoming)) {
    const previousKeys = Object.keys(previous);
    const incomingKeys = Object.keys(incoming);
    let equal = previousKeys.length === incomingKeys.length;
    const shared: Record<string, unknown> = {};
    for (const key of incomingKeys) {
      const next = replaceEqualDeep(previous[key], incoming[key]);
      shared[key] = next;
      if (!Object.prototype.hasOwnProperty.call(previous, key)
        || !Object.is(next, previous[key])) equal = false;
    }
    return (equal ? previous : shared) as T;
  }
  return incoming;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
