const POST_RESULT_DRAIN = Symbol("claude_post_result_drain");

type PhaseMarkedEvent = object & {
  [POST_RESULT_DRAIN]?: true;
};

export function markPostResultDrainEvent<T extends object>(event: T): T {
  Object.defineProperty(event, POST_RESULT_DRAIN, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  return event;
}

export function isPostResultDrainEvent(event: object): boolean {
  return (event as PhaseMarkedEvent)[POST_RESULT_DRAIN] === true;
}
