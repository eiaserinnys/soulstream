import { useCallback, useMemo, useRef, useState } from "react";

import type { MessageOrGroup } from "../../lib/grouping";
import {
  computeFirstItemIndex,
  countInsertedRowsBeforeKey,
  messageOrGroupKey,
} from "./ChatView.reverse-helpers";

interface LogicalCoordinate {
  sessionKey: string | null;
  groupedKeys: string[];
  prependedCount: number;
  insertedBeforeVisible: number;
}

/**
 * history prepend와 live 중간 삽입을 하나의 Virtuoso 절대 좌표로 합성한다.
 * store는 viewport를 모르므로 실제 history prepend만 소유하고, stable first-visible
 * key 앞의 논리 삽입은 ChatView 경계의 이 훅에서만 계산한다.
 */
export function useChatLogicalInsertionCoordinate(
  grouped: MessageOrGroup[],
  sessionKey: string | null,
  prependedCount: number,
): {
  firstItemIndex: number;
  recordFirstVisibleKey: (key: string | null) => void;
} {
  const groupedKeys = useMemo(() => grouped.map(messageOrGroupKey), [grouped]);
  const firstVisibleRef = useRef<{
    sessionKey: string | null;
    key: string | null;
  }>({ sessionKey, key: null });
  const [coordinate, setCoordinate] = useState<LogicalCoordinate>(() => ({
    sessionKey,
    groupedKeys,
    prependedCount,
    insertedBeforeVisible: 0,
  }));

  let renderCoordinate = coordinate;
  if (
    coordinate.sessionKey !== sessionKey ||
    coordinate.groupedKeys !== groupedKeys ||
    coordinate.prependedCount !== prependedCount
  ) {
    const isSameSession = coordinate.sessionKey === sessionKey;
    const shouldResetViewportBasis =
      !isSameSession ||
      groupedKeys.length === 0 ||
      prependedCount < coordinate.prependedCount;
    if (shouldResetViewportBasis) {
      firstVisibleRef.current = { sessionKey, key: null };
    }
    const nextCoordinate: LogicalCoordinate = {
      sessionKey,
      groupedKeys,
      prependedCount,
      insertedBeforeVisible:
        shouldResetViewportBasis
          ? 0
          : coordinate.prependedCount === prependedCount
            ? coordinate.insertedBeforeVisible + countInsertedRowsBeforeKey(
                coordinate.groupedKeys,
                groupedKeys,
                firstVisibleRef.current.sessionKey === sessionKey
                  ? firstVisibleRef.current.key
                  : null,
              )
            : coordinate.insertedBeforeVisible,
    };
    setCoordinate(nextCoordinate);
    renderCoordinate = nextCoordinate;
  }

  const firstItemIndex = computeFirstItemIndex(
    prependedCount + renderCoordinate.insertedBeforeVisible,
  );
  const recordFirstVisibleKey = useCallback(
    (key: string | null) => {
      firstVisibleRef.current = {
        sessionKey,
        key,
      };
    },
    [sessionKey],
  );

  return { firstItemIndex, recordFirstVisibleKey };
}
