import { useEffect, useState } from "react";

import { dateKey } from "./v3-dashboard-utils";

export function useTodayDate(): string {
  const [today, setToday] = useState(() => dateKey(new Date()));

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const refresh = () => {
      const now = new Date();
      setToday(dateKey(now));
      const nextMidnight = new Date(now);
      nextMidnight.setHours(24, 0, 0, 0);
      timer = setTimeout(refresh, nextMidnight.getTime() - now.getTime());
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        clearTimeout(timer);
        refresh();
      }
    };
    const now = new Date();
    const nextMidnight = new Date(now);
    nextMidnight.setHours(24, 0, 0, 0);
    timer = setTimeout(refresh, nextMidnight.getTime() - now.getTime());
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  return today;
}
