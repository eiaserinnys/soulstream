/** Pure predicates for the chat view's explicit follow behavior. */

export function resolveFollowOutput(userFollowing: boolean): "auto" | false {
  return userFollowing ? "auto" : false;
}

export function shouldScrollToBottomOnTreeChange(
  userFollowing: boolean,
  itemCount: number,
): boolean {
  return userFollowing && itemCount > 0;
}
