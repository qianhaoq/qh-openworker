// Narrow-window rescue: when the viewport crosses a media query downward (starts
// matching), fire the callback ONCE so the caller can close a side panel. Never
// fires on the upward crossing and never re-fires while the query keeps matching,
// so a manual re-open is never fought. A window that starts narrow counts as a
// crossing (close it up front).

import { useEffect, useRef } from "react";

export function useAutoCloseBelow(query: string, onCrossDown: () => void): void {
  const cbRef = useRef(onCrossDown);
  cbRef.current = onCrossDown;

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(query);
    // The change event only fires on a crossing; e.matches true = downward.
    const onChange = (e: MediaQueryListEvent) => {
      if (e.matches) cbRef.current();
    };
    if (mql.matches) cbRef.current(); // already narrow at mount
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
}
